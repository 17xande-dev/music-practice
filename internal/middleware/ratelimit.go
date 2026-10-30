package middleware

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// maxBuckets is the most buckets one limiter holds. The lazy sweep only runs
// once per idle period, so a spray of distinct keys could otherwise fill the
// map well inside it; the cap is what makes the size a bound.
const maxBuckets = 10_000

// capSweepEvery is the least time between sweeps triggered by hitting the cap.
// A sweep scans every bucket under the lock, so at the cap an attacker's
// request rate must not become the lock's busy time.
const capSweepEvery = 5 * time.Second

// Limiter is a token bucket per key (an email, an IP, a user id). Buckets
// idle for longer than it takes to refill are dropped by a lazy sweep, and
// the map never holds more than maxBuckets: once full of live keys a new key
// is refused (fail closed) until a sweep frees room.
type Limiter struct {
	mu        sync.Mutex
	every     rate.Limit
	burst     int
	idle      time.Duration
	buckets   map[string]*bucket
	lastSweep time.Time
	capSwept  time.Time
	max       int
	now       func() time.Time
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

// NewLimiter allows burst events at once, then one per interval.
func NewLimiter(burst int, interval time.Duration) *Limiter {
	return &Limiter{
		every:   rate.Every(interval),
		burst:   burst,
		idle:    time.Duration(burst) * interval,
		buckets: map[string]*bucket{},
		max:     maxBuckets,
		now:     time.Now,
	}
}

// Allow spends one token from key's bucket, reporting false when it is empty.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.lastSweep) > l.idle {
		l.sweep(now)
	}
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= l.max {
			// Idle buckets cost nothing to forget; try that first, but at most
			// once per capSweepEvery so a flood is refused without rescanning.
			if l.capSwept.IsZero() || now.Sub(l.capSwept) >= capSweepEvery {
				l.sweep(now)
				l.capSwept = now
			}
			if len(l.buckets) >= l.max {
				// Still full of live keys. Failing open would let a flood of
				// fresh keys switch the limiter off.
				return false
			}
		}
		b = &bucket{lim: rate.NewLimiter(l.every, l.burst)}
		l.buckets[key] = b
	}
	b.seen = now
	return b.lim.AllowN(now, 1)
}

func (l *Limiter) sweep(now time.Time) {
	for k, b := range l.buckets {
		if now.Sub(b.seen) > l.idle {
			delete(l.buckets, k)
		}
	}
	l.lastSweep = now
}

// Len is how many buckets are held, for tests.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// Keys lists the held bucket keys, for tests.
func (l *Limiter) Keys() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	keys := make([]string, 0, len(l.buckets))
	for k := range l.buckets {
		keys = append(keys, k)
	}
	return keys
}

// ClientIP returns the visitor's address: from header when the deployment
// names one (a proxy such as Cloudflare sets it), else the connection's.
//
// A single-value header the proxy overwrites (CF-Connecting-IP, X-Real-IP) is
// the safe choice. X-Forwarded-For is a list every hop appends to, and the
// client may have put anything at its front, so for that header only the
// rightmost entry (the one our own proxy added) is trusted. Any other header
// is read whole.
func ClientIP(header string) func(*http.Request) string {
	header = http.CanonicalHeaderKey(header)
	return func(r *http.Request) string {
		if header != "" {
			if v := r.Header.Values(header); len(v) > 0 {
				last := v[len(v)-1]
				if header == "X-Forwarded-For" {
					if i := strings.LastIndexByte(last, ','); i >= 0 {
						last = last[i+1:]
					}
				}
				if ip := net.ParseIP(strings.TrimSpace(last)); ip != nil {
					return ip.String()
				}
			}
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			return r.RemoteAddr
		}
		return host
	}
}

// IPKey is the key a per-IP limiter should use for ip: an IPv6 client owns a
// whole /64 (any one subscriber can pick addresses freely within it), so the
// /64 is one bucket; an IPv4 address is its own.
func IPKey(ip string) string {
	a := net.ParseIP(ip)
	if a == nil {
		return ip
	}
	if a4 := a.To4(); a4 != nil {
		return a4.String()
	}
	return a.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

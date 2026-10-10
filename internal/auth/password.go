// Package auth holds the credential primitives: password hashing, generated
// passwords, and session tokens. It knows nothing about HTTP or the database.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// MinPasswordLength is the whole password policy. Composition rules push
// people towards short mangled words; length plus argon2id is what actually
// makes guessing expensive.
const MinPasswordLength = 12

// MaxPasswordLength bounds the work one request can ask argon2 to hash.
const MaxPasswordLength = 256

// argon2id parameters. 64 MiB and three passes cost roughly 100ms here, a
// price paid once per sign-in; every endpoint that verifies a password is
// rate-limited because each call also holds that 64 MiB.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16
)

var ErrPasswordTooShort = fmt.Errorf("the password must be at least %d characters", MinPasswordLength)
var ErrPasswordTooLong = fmt.Errorf("the password must be at most %d characters", MaxPasswordLength)

// CheckPolicy reports why a new password is unacceptable, or nil.
func CheckPolicy(pw string) error {
	n := utf8.RuneCountInString(pw)
	if n < MinPasswordLength {
		return ErrPasswordTooShort
	}
	if len(pw) > MaxPasswordLength {
		return ErrPasswordTooLong
	}
	return nil
}

// HashPassword returns an argon2id hash in the PHC string format
// ($argon2id$v=19$m=…,t=…,p=…$salt$key), so the parameters travel with the
// hash and can be raised later without breaking existing ones.
func HashPassword(pw string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

var errBadHash = errors.New("auth: malformed password hash")

// VerifyPassword reports whether pw matches the stored hash. An unparseable
// hash is an error, never a match.
func VerifyPassword(pw, hash string) (bool, error) {
	if len(pw) > MaxPasswordLength {
		return false, nil
	}
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	var m, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil || m == 0 || t == 0 || p == 0 {
		return false, errBadHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil || len(want) == 0 {
		return false, errBadHash
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// dummyHash is verified against when the email is unknown, so a sign-in
// for a missing account costs the same as one for a real account: otherwise
// the response time says which emails have accounts.
var dummyHash = func() string {
	h, err := HashPassword("not a real password, only spends time")
	if err != nil {
		panic(err)
	}
	return h
}()

// SpendVerifyTime does the work of one VerifyPassword and discards it.
func SpendVerifyTime(pw string) {
	VerifyPassword(pw, dummyHash)
}

// passwordAlphabet leaves out characters that read alike (0/O, 1/l/I), since
// a generated password is read off one screen and typed into another device.
const passwordAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// GeneratePassword returns a random 20-character password, about 116 bits:
// what an admin hands to a new user, who changes it after signing in.
func GeneratePassword() string {
	b := make([]byte, 20)
	for i := range b {
		b[i] = passwordAlphabet[randIntn(len(passwordAlphabet))]
	}
	return string(b)
}

// randIntn is uniform in [0, n) by rejection sampling, so no character is
// more likely than another.
func randIntn(n int) int {
	limit := 256 - 256%n
	var buf [1]byte
	for {
		if _, err := rand.Read(buf[:]); err != nil {
			panic(err) // crypto/rand does not fail on supported platforms
		}
		if int(buf[0]) < limit {
			return int(buf[0]) % n
		}
	}
}

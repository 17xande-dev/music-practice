package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/17xande-dev/music-practice/internal/auth"
	"github.com/17xande-dev/websec/webtest"
)

// api sends a JSON request with a bearer token, a cookie, or neither.
func (s *testServer) api(t *testing.T, method, target, body, token, cookie string) *webtest.Response {
	t.Helper()
	c := s.client(t, cookie)
	r := c.NewRequest(method, target, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return c.Do(r)
}

// deviceToken signs in the way the iPad app does.
func (s *testServer) deviceToken(t *testing.T, email, password string) string {
	t.Helper()
	rec := s.api(t, "POST", "/api/token", fmt.Sprintf(`{"email":%q,"password":%q,"label":"iPad"}`, email, password), "", "")
	if rec.Status != http.StatusOK {
		t.Fatalf("token: %d %s", rec.Status, rec.Body)
	}
	var resp struct{ Token, Email string }
	json.Unmarshal([]byte(rec.Body), &resp)
	if resp.Token == "" || resp.Email != email {
		t.Fatalf("token response %s", rec.Body)
	}
	return resp.Token
}

type syncResult struct {
	Cursor   int64                        `json:"cursor"`
	Records  map[string][]json.RawMessage `json:"records"`
	Deleted  []struct{ Kind, ID string }  `json:"deleted"`
	More     bool                         `json:"more"`
	Rejected []struct{ Kind, ID, Reason string }
}

func (s *testServer) sync(t *testing.T, body, token, cookie string) syncResult {
	t.Helper()
	rec := s.api(t, "POST", "/api/sync", body, token, cookie)
	if rec.Status != http.StatusOK {
		t.Fatalf("sync: %d %s", rec.Status, rec.Body)
	}
	var res syncResult
	if err := json.Unmarshal([]byte(rec.Body), &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func runJSON(id string) string { return fmt.Sprintf(`{"id":%q,"ts":1700000000000,"accuracy":0.9}`, id) }

func TestExpiredLegacyDeviceTokenRequiresSignIn(t *testing.T) {
	for _, tc := range []struct {
		name      string
		age, idle time.Duration
	}{
		{"absolute", 366 * 24 * time.Hour, 0},
		{"idle", 91 * 24 * time.Hour, 90 * 24 * time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestServer(t)
			u := s.addUser(t, "u@example.com", false)
			tok := s.deviceToken(t, u.Email, testPassword)
			now := s.accounts.Now().UTC()
			// Before P2 device rows had no stored expiry. Both types of
			// timeout must still produce the client's signed-out response.
			if _, err := s.db.ExecContext(t.Context(), `UPDATE auth_sessions
				SET created_at = ?, last_used_at = ?, expires_at = '' WHERE token_hash = ?`,
				now.Add(-tc.age).Format(time.RFC3339), now.Add(-tc.idle).Format(time.RFC3339), auth.HashToken(tok)); err != nil {
				t.Fatal(err)
			}
			rec := s.api(t, "POST", "/api/sync", `{"cursor":0}`, tok, "")
			if rec.Status != http.StatusUnauthorized || rec.Header.Get("Cache-Control") != "no-store" ||
				strings.TrimSpace(rec.Body) != `{"error":"not signed in"}` {
				t.Fatalf("expired token got status %d, want 401 with the signed-out error", rec.Status)
			}
			fresh := s.deviceToken(t, u.Email, testPassword)
			if rec := s.api(t, "POST", "/api/sync", `{"cursor":0}`, fresh, ""); rec.Status != http.StatusOK {
				t.Fatalf("sync after signing in again: status %d", rec.Status)
			}
		})
	}
}

func TestActiveDeviceTokenIgnoresStaleStoredExpiry(t *testing.T) {
	s := newTestServer(t)
	u := s.addUser(t, "u@example.com", false)
	tok := s.deviceToken(t, u.Email, testPassword)
	if _, err := s.db.ExecContext(t.Context(), `UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE token_hash = ?`, auth.HashToken(tok)); err != nil {
		t.Fatal(err)
	}
	if rec := s.api(t, "GET", "/api/me", "", tok, ""); rec.Status != http.StatusOK {
		t.Fatalf("active token with stale stored expiry: status %d, want 200", rec.Status)
	}
}

// The iPad and the browser are the same account: what one pushes, the other
// pulls, whichever way each authenticates.
func TestSyncBetweenDeviceAndBrowser(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	cookie := s.signIn(t, "a@x.com", testPassword)

	pushed := s.sync(t, `{"cursor":0,"push":{"song":[`+runJSON("s1")+`],"scale":[`+runJSON("r1")+`]}}`, token, "")
	if len(pushed.Rejected) != 0 {
		t.Fatalf("rejected: %+v", pushed.Rejected)
	}
	got := s.sync(t, `{"cursor":0}`, "", cookie)
	if len(got.Records["song"]) != 1 || len(got.Records["scale"]) != 1 || len(got.Records["learn"]) != 0 {
		t.Fatalf("browser pulled %+v", got.Records)
	}
	// The run comes back exactly as pushed: the server stores the app's JSON.
	if string(got.Records["song"][0]) != runJSON("s1") {
		t.Errorf("record changed in transit: %s", got.Records["song"][0])
	}
	// Nothing new after the cursor.
	if again := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, got.Cursor), "", cookie); len(again.Records["song"])+len(again.Records["scale"]) != 0 {
		t.Error("records repeated past the cursor")
	}

	// The browser deletes the song run; the device learns of it.
	s.sync(t, `{"cursor":0,"deleted":[{"kind":"song","id":"s1"}]}`, "", cookie)
	dev := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, pushed.Cursor), token, "")
	if len(dev.Deleted) != 1 || dev.Deleted[0].ID != "s1" {
		t.Fatalf("device did not learn of the deletion: %+v", dev)
	}
	// And a stale device re-pushing it does not bring it back.
	again := s.sync(t, `{"cursor":0,"push":{"song":[`+runJSON("s1")+`]}}`, token, "")
	if len(again.Records["song"]) != 0 {
		t.Error("deleted run came back")
	}
}

// Every response is arrays, never null, so clients can iterate blindly.
func TestSyncEmptyResponseShape(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	rec := s.api(t, "POST", "/api/sync", `{"cursor":0}`, token, "")
	want := `{"cursor":0,"records":{"learn":[],"scale":[],"song":[]},"deleted":[],"more":false,"rejected":[]}`
	if got := strings.TrimSpace(rec.Body); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

// A bad run is reported, not fatal: the rest of the push still lands, and
// the client learns to stop resending it.
func TestSyncRejectsBadRecordsIndividually(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	res := s.sync(t, `{"cursor":0,"push":{"scale":[`+runJSON("ok")+`,{"id":"nots"}],"chord":[`+runJSON("x")+`]}}`, token, "")
	if len(res.Rejected) != 2 {
		t.Fatalf("rejected %+v", res.Rejected)
	}
	if len(res.Records["scale"]) != 1 {
		t.Errorf("good record not stored: %+v", res.Records)
	}
}

func TestSyncBadRequests(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	for name, body := range map[string]string{
		"not json":        `nope`,
		"negative cursor": `{"cursor":-1}`,
		"wrong type":      `{"cursor":"0"}`,
	} {
		if rec := s.api(t, "POST", "/api/sync", body, token, ""); rec.Status != http.StatusBadRequest {
			t.Errorf("%s: %d", name, rec.Status)
		}
	}
	huge := `{"cursor":0,"push":{"scale":["` + strings.Repeat("x", maxSyncBody) + `"]}}`
	if rec := s.api(t, "POST", "/api/sync", huge, token, ""); rec.Status != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized: %d", rec.Status)
	}
}

// One user's history is never reachable by another's credentials.
func TestSyncIsPerUser(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	s.addUser(t, "b@x.com", false)
	a := s.deviceToken(t, "a@x.com", testPassword)
	b := s.deviceToken(t, "b@x.com", testPassword)
	s.sync(t, `{"cursor":0,"push":{"scale":[`+runJSON("r1")+`]}}`, a, "")
	if res := s.sync(t, `{"cursor":0}`, b, ""); len(res.Records["scale"]) != 0 {
		t.Fatal("b pulled a's run")
	}
}

func TestSyncPaginates(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	// A push is capped at maxPush records, so build the history in two requests.
	push := func(from, to int) {
		var runs []string
		for i := from; i < to; i++ {
			runs = append(runs, runJSON(fmt.Sprint("r", i)))
		}
		if res := s.sync(t, `{"cursor":0,"push":{"scale":[`+strings.Join(runs, ",")+`]}}`, token, ""); len(res.Rejected) != 0 {
			t.Fatalf("rejected %+v", res.Rejected)
		}
	}
	push(0, 500)
	push(500, pullLimit+5)
	first := s.sync(t, `{"cursor":0}`, token, "")
	if !first.More || len(first.Records["scale"]) != pullLimit {
		t.Fatalf("first page: %d more=%v", len(first.Records["scale"]), first.More)
	}
	second := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, first.Cursor), token, "")
	if second.More || len(second.Records["scale"]) != 5 {
		t.Fatalf("second page: %d more=%v", len(second.Records["scale"]), second.More)
	}
}

func TestAPIRefusesAnonymous(t *testing.T) {
	s := newTestServer(t)
	for _, route := range []string{"GET /api/me", "POST /api/sync", "DELETE /api/token"} {
		method, path, _ := strings.Cut(route, " ")
		for _, token := range []string{"", "made-up"} {
			rec := s.api(t, method, path, `{}`, token, "")
			if rec.Status != http.StatusUnauthorized || !strings.Contains(rec.Body, `"error"`) {
				t.Errorf("%s token=%q: %d %s", route, token, rec.Status, rec.Body)
			}
		}
	}
}

// The token endpoint is the app's sign-in form: same single failure
// message, same rate limit.
func TestTokenSignIn(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	for _, body := range []string{`{"email":"a@x.com","password":"wrong password!"}`, `{"email":"no@x.com","password":"whatever it is"}`} {
		rec := s.api(t, "POST", "/api/token", body, "", "")
		if rec.Status != http.StatusUnauthorized || !strings.Contains(rec.Body, loginFailed) {
			t.Errorf("%s: %d %s", body, rec.Status, rec.Body)
		}
	}
	for range 5 {
		s.api(t, "POST", "/api/token", `{"email":"a@x.com","password":"wrong password!"}`, "", "")
	}
	if rec := s.api(t, "POST", "/api/token", `{"email":"a@x.com","password":"`+testPassword+`"}`, "", ""); rec.Status != http.StatusTooManyRequests {
		t.Errorf("not rate limited: %d", rec.Status)
	}
}

func TestMalformedHashTokenSignInIsGenericAndRateLimited(t *testing.T) {
	s := newTestServer(t)
	if _, err := s.accounts.Create(t.Context(), "broken@x.com", "invalid hash", false); err != nil {
		t.Fatal(err)
	}
	body := `{"email":"broken@x.com","password":"a long enough password"}`
	for range 5 {
		rec := s.api(t, "POST", "/api/token", body, "", "")
		if rec.Status != http.StatusUnauthorized || !strings.Contains(rec.Body, loginFailed) {
			t.Fatalf("malformed hash: %d %s", rec.Status, rec.Body)
		}
	}
	if rec := s.api(t, "POST", "/api/token", body, "", ""); rec.Status != http.StatusTooManyRequests {
		t.Fatalf("malformed-hash attempts must count toward the rate limit: %d", rec.Status)
	}
}

// Signing the app out kills its token, and the device shows on the account
// page until then, labelled as the app named it.
func TestTokenSignOut(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	cookie := s.signIn(t, "a@x.com", testPassword)
	if !strings.Contains(s.do(t, "GET", "/account", nil, cookie).Body, "iPad") {
		t.Error("device missing from the account page")
	}
	if rec := s.api(t, "GET", "/api/me", "", token, ""); rec.Status != 200 || !strings.Contains(rec.Body, "a@x.com") {
		t.Fatalf("me: %d %s", rec.Status, rec.Body)
	}
	if rec := s.api(t, "DELETE", "/api/token", "", token, ""); rec.Status != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Status)
	}
	if rec := s.api(t, "GET", "/api/me", "", token, ""); rec.Status != http.StatusUnauthorized {
		t.Error("token works after sign-out")
	}
	// The browser session is untouched.
	if rec := s.api(t, "GET", "/api/me", "", "", cookie); rec.Status != 200 {
		t.Error("app sign-out ended the browser session")
	}
}

// An account the admin creates signs in on both the web and the app with
// the password shown once.
func TestCreatedAccountWorksForWebAndApp(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "admin@x.com", true)
	cookie := s.signIn(t, "admin@x.com", testPassword)
	rec := s.do(t, "POST", "/admin/users", url.Values{"email": {"p@x.com"}}, cookie)
	pw := shownPassword.FindStringSubmatch(rec.Body)[1]
	s.signIn(t, "p@x.com", pw)
	s.deviceToken(t, "p@x.com", pw)
}

// A database fault while checking a token is a 500, not a 401: clients take
// 401 to mean the token is dead and throw it away.
func TestAuthFaultIsNotSignedOut(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	s.db.Close()
	if rec := s.api(t, "GET", "/api/me", "", token, ""); rec.Status != http.StatusInternalServerError {
		t.Errorf("auth fault: %d, want 500", rec.Status)
	}
	if rec := s.api(t, "GET", "/api/me", "", "", ""); rec.Status != http.StatusUnauthorized {
		t.Errorf("no credentials: %d, want 401", rec.Status)
	}
}

// A disabled account's app token stops working at once.
func TestDisabledUserTokenRefused(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "admin@x.com", true)
	u := s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	s.accounts.SetDisabled(t.Context(), u.ID, true)
	if rec := s.api(t, "POST", "/api/sync", `{"cursor":0}`, token, ""); rec.Status != http.StatusUnauthorized {
		t.Errorf("disabled user synced: %d", rec.Status)
	}
}

// The browser's sync is a same-origin fetch; a cross-site one is refused
// before it can push into the visitor's account.
func TestCrossSiteSyncRefused(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	cookie := s.signIn(t, "a@x.com", testPassword)
	// Only Sec-Fetch-Site and the cookie, as before: no Origin, no JSON content type.
	c := s.client(t, cookie, webtest.NoOrigin(), webtest.SecFetchSite("cross-site"))
	if rec := c.Do(c.NewRequest(http.MethodPost, "/api/sync", strings.NewReader(`{"cursor":0}`))); rec.Status != http.StatusForbidden {
		t.Errorf("cross-site sync: %d", rec.Status)
	}
}

// A refused run must come back with its id (an oversize one, a bad-ts one, an
// empty-id one), or a client that drops rejects by id keeps resending it.
func TestSyncRejectedCarriesIDWhateverTheReason(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	big := `{"id":"fat","ts":1,"pad":"` + strings.Repeat("x", 70<<10) + `"}`
	body := `{"cursor":0,"push":{"scale":[` + big + `,{"id":"badts","ts":0},{"id":"","ts":1},{"ts":1},{"id":7,"ts":1}]}}`
	rec := s.api(t, "POST", "/api/sync", body, token, "")
	if rec.Status != http.StatusOK {
		t.Fatalf("sync: %d", rec.Status)
	}
	var res struct {
		Rejected []map[string]any `json:"rejected"`
	}
	if err := json.Unmarshal([]byte(rec.Body), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Rejected) != 5 {
		t.Fatalf("rejected %+v", res.Rejected)
	}
	want := []any{"fat", "badts", "", nil, nil} // nil: no string id, so none returned
	for i, w := range want {
		id, has := res.Rejected[i]["id"]
		if w == nil && has || w != nil && id != w {
			t.Errorf("rejected[%d] = %+v, want id %v", i, res.Rejected[i], w)
		}
	}
}

func TestSyncAccountMismatch(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	s.addUser(t, "b@x.com", false)
	cookie := s.signIn(t, "b@x.com", testPassword)
	// A browser whose cookie is b's, syncing as a: nothing may be stored or returned.
	rec := s.api(t, "POST", "/api/sync", `{"account":"a@x.com","cursor":0,"push":{"scale":[`+runJSON("mine")+`]}}`, "", cookie)
	if rec.Status != http.StatusConflict || strings.TrimSpace(rec.Body) != `{"error":"account mismatch"}` {
		t.Fatalf("mismatch: %d %s", rec.Status, rec.Body)
	}
	if got := s.sync(t, `{"cursor":0}`, "", cookie); len(got.Records["scale"]) != 0 {
		t.Error("a mismatched push was stored under the session's account")
	}
	// The right account, in any case or padding, and an omitted field, both work.
	for _, body := range []string{`{"account":"b@x.com","cursor":0}`, `{"account":" B@X.com ","cursor":0}`, `{"cursor":0}`} {
		if rec := s.api(t, "POST", "/api/sync", body, "", cookie); rec.Status != http.StatusOK {
			t.Errorf("%s: %d", body, rec.Status)
		}
	}
	// Junk is a mismatch, not a pass.
	if rec := s.api(t, "POST", "/api/sync", `{"account":"not an email","cursor":0}`, "", cookie); rec.Status != http.StatusConflict {
		t.Errorf("junk account: %d", rec.Status)
	}
}

func TestSyncPushCaps(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	recs := func(n int) string {
		var r []string
		for i := range n {
			r = append(r, runJSON(fmt.Sprint("c", i)))
		}
		return strings.Join(r, ",")
	}
	// 600 + 401 across two kinds is over 1000 in total.
	over := `{"push":{"scale":[` + recs(600) + `],"song":[` + strings.ReplaceAll(recs(401), `"c`, `"s`) + `]}}`
	if rec := s.api(t, "POST", "/api/sync", over, token, ""); rec.Status != http.StatusBadRequest {
		t.Errorf("1001 records: %d", rec.Status)
	}
	var dels []string
	for i := range 1001 {
		dels = append(dels, fmt.Sprintf(`{"kind":"scale","id":"d%d"}`, i))
	}
	if rec := s.api(t, "POST", "/api/sync", `{"deleted":[`+strings.Join(dels, ",")+`]}`, token, ""); rec.Status != http.StatusBadRequest {
		t.Errorf("1001 deletions: %d", rec.Status)
	}
	// Exactly 1000 of each is fine.
	ok := `{"push":{"scale":[` + recs(1000) + `]},"deleted":[` + strings.Join(dels[:1000], ",") + `]}`
	if rec := s.api(t, "POST", "/api/sync", ok, token, ""); rec.Status != http.StatusOK {
		t.Errorf("1000 and 1000: %d %.100s", rec.Status, rec.Body)
	}
	// And nothing from the refused requests was stored.
	got := s.sync(t, `{"cursor":0}`, token, "")
	if len(got.Records["song"]) != 0 {
		t.Errorf("a refused push stored %d ink records", len(got.Records["song"]))
	}
}

// A response is capped by bytes as well as by records, and says so with more.
func TestSyncPullPagesByBytes(t *testing.T) {
	s := newTestServer(t)
	s.addUser(t, "a@x.com", false)
	token := s.deviceToken(t, "a@x.com", testPassword)
	pad := strings.Repeat("x", 50<<10)
	var runs []string
	for i := range 100 { // ~5 MB of data
		runs = append(runs, fmt.Sprintf(`{"id":"r%d","ts":1,"pad":%q}`, i, pad))
	}
	for i := 0; i < 100; i += 50 {
		if res := s.sync(t, `{"push":{"scale":[`+strings.Join(runs[i:i+50], ",")+`]}}`, token, ""); len(res.Rejected) != 0 {
			t.Fatalf("rejected %+v", res.Rejected)
		}
	}
	first := s.sync(t, `{"cursor":0}`, token, "")
	if !first.More || len(first.Records["scale"]) >= 100 || len(first.Records["scale"]) < 50 {
		t.Fatalf("first page: %d records, more=%v", len(first.Records["scale"]), first.More)
	}
	n := 0
	for _, r := range first.Records["scale"] {
		n += len(r)
	}
	if n > pullBytes {
		t.Errorf("page carries %d bytes of data, cap is %d", n, pullBytes)
	}
	cursor, total := first.Cursor, len(first.Records["scale"])
	for more := true; more; {
		res := s.sync(t, fmt.Sprintf(`{"cursor":%d}`, cursor), token, "")
		cursor, total, more = res.Cursor, total+len(res.Records["scale"]), res.More
	}
	if total != 100 {
		t.Errorf("paged through %d of 100 records", total)
	}
}

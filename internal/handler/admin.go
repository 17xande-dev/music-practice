package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/17xande-dev/music-practice/internal/account"
	"github.com/17xande-dev/music-practice/internal/auth"
)

// The admin area: creating and managing accounts. There is no sign-up, so
// this is how every account after the first comes to exist.

var adminNotices = map[string]string{
	"disabled":    "The account is disabled and signed out everywhere.",
	"enabled":     "The account is enabled.",
	"promoted":    "The account is now an admin.",
	"demoted":     "The account is no longer an admin.",
	"signed-out":  "The account is signed out on every device.",
	"deleted":     "The account and its history are deleted.",
	"last-admin":  "That would leave no enabled admin, so nothing was changed.",
	"self":        "You can't do that to your own account here.",
	"not-found":   "That account no longer exists.",
	"bad-request": "That request was not understood.",
}

type adminUsersPage struct {
	Users  []account.UserSummary
	SelfID int64
	Notice string
	// Create form state, kept when the form is refused.
	Email, Error string
	Admin        bool
}

// adminPasswordPage shows a generated password, once.
type adminPasswordPage struct {
	Email    string
	Password string
	Created  bool
}

type adminDeletePage struct {
	User account.User
}

// requireAdmin wraps an admin route. Someone signed out is sent to sign in;
// someone signed in without the role gets the same 404 as a path that does
// not exist, so the area does not announce itself.
func (h *Handler) requireAdmin(next func(http.ResponseWriter, *http.Request, account.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, _, ok := h.currentUser(r)
		if !ok {
			target := "/account"
			if r.Method == http.MethodGet {
				target = "/account?next=" + r.URL.Path
			}
			http.Redirect(w, r, target, http.StatusSeeOther)
			return
		}
		if !u.IsAdmin {
			http.NotFound(w, r)
			return
		}
		next(w, r, u)
	}
}

// adminHeaders marks every response under /admin, its 404s included, as
// never to be indexed or cached: the pages list people's emails.
func adminHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/admin" || strings.HasPrefix(r.URL.Path, "/admin/") {
			w.Header().Set("X-Robots-Tag", "noindex")
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func (h *Handler) adminUsers(w http.ResponseWriter, r *http.Request, me account.User) {
	h.renderAdminUsers(w, r, me, http.StatusOK, adminUsersPage{Notice: adminNotices[r.URL.Query().Get("notice")]})
}

func (h *Handler) renderAdminUsers(w http.ResponseWriter, r *http.Request, me account.User, status int, page adminUsersPage) {
	users, err := h.accounts.List(r.Context())
	if err != nil {
		h.serverError(w, err)
		return
	}
	page.Users, page.SelfID = users, me.ID
	h.render(w, status, "admin_users.html", "Accounts", page)
}

// adminCreate makes an account with a generated password and shows that
// password on this response, once. There is no redirect: a redirect would
// need the password in the URL (history, logs) or stored somewhere to show
// it after.
func (h *Handler) adminCreate(w http.ResponseWriter, r *http.Request, me account.User) {
	email := strings.TrimSpace(r.PostFormValue("email"))
	admin := r.PostFormValue("admin") == "1"
	refuse := func(status int, msg string) {
		h.renderAdminUsers(w, r, me, status, adminUsersPage{Email: email, Admin: admin, Error: msg})
	}
	pw := auth.GeneratePassword()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		h.serverError(w, err)
		return
	}
	u, err := h.accounts.Create(r.Context(), email, hash, admin)
	switch {
	case errors.Is(err, account.ErrBadEmail):
		refuse(http.StatusBadRequest, "That is not a valid email address.")
		return
	case errors.Is(err, account.ErrExists):
		refuse(http.StatusConflict, "There is already an account for that email.")
		return
	case err != nil:
		h.serverError(w, err)
		return
	}
	h.log.Info("account created", "by", me.Email, "user", u.Email, "admin", admin)
	h.render(w, http.StatusOK, "admin_password.html", "New account", adminPasswordPage{Email: u.Email, Password: pw, Created: true})
}

// adminTarget reads the {id} in the path and loads that user. An admin
// acting on their own account is refused for the destructive actions: the
// account page is where you manage yourself, and it keeps an admin from
// locking themselves out with one click.
func (h *Handler) adminTarget(w http.ResponseWriter, r *http.Request, me account.User, allowSelf bool) (account.User, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		adminRedirect(w, r, "bad-request")
		return account.User{}, false
	}
	if id == me.ID && !allowSelf {
		adminRedirect(w, r, "self")
		return account.User{}, false
	}
	u, err := h.accounts.ByID(r.Context(), id)
	if errors.Is(err, account.ErrNotFound) {
		adminRedirect(w, r, "not-found")
		return account.User{}, false
	}
	if err != nil {
		h.serverError(w, err)
		return account.User{}, false
	}
	return u, true
}

func adminRedirect(w http.ResponseWriter, r *http.Request, notice string) {
	http.Redirect(w, r, "/admin/users?notice="+notice, http.StatusSeeOther)
}

func (h *Handler) adminReset(w http.ResponseWriter, r *http.Request, me account.User) {
	u, ok := h.adminTarget(w, r, me, false)
	if !ok {
		return
	}
	pw := auth.GeneratePassword()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		h.serverError(w, err)
		return
	}
	// Ends every session: whoever knew the old password is out.
	if err := h.accounts.SetPassword(r.Context(), u.ID, hash, 0); err != nil {
		h.serverError(w, err)
		return
	}
	h.log.Info("password reset", "by", me.Email, "user", u.Email)
	h.render(w, http.StatusOK, "admin_password.html", "New password", adminPasswordPage{Email: u.Email, Password: pw})
}

// adminAction builds the one-step POST actions. Each changes one thing and
// redirects back to the list with a notice.
func (h *Handler) adminAction(do func(r *http.Request, u account.User) error, notice string) func(http.ResponseWriter, *http.Request, account.User) {
	return func(w http.ResponseWriter, r *http.Request, me account.User) {
		u, ok := h.adminTarget(w, r, me, false)
		if !ok {
			return
		}
		err := do(r, u)
		switch {
		case errors.Is(err, account.ErrLastAdmin):
			adminRedirect(w, r, "last-admin")
		case errors.Is(err, account.ErrNotFound):
			adminRedirect(w, r, "not-found")
		case err != nil:
			h.serverError(w, err)
		default:
			h.log.Info("account changed", "by", me.Email, "user", u.Email, "change", notice)
			adminRedirect(w, r, notice)
		}
	}
}

func (h *Handler) adminDeleteConfirm(w http.ResponseWriter, r *http.Request, me account.User) {
	u, ok := h.adminTarget(w, r, me, false)
	if !ok {
		return
	}
	h.render(w, http.StatusOK, "admin_delete.html", "Delete account", adminDeletePage{User: u})
}

// registerAdmin registers every admin route through handle. It takes the
// function rather than the mux so a test can collect the patterns: the
// "every admin route refuses non-admins" test is derived from this list and
// cannot miss a route added later.
func (h *Handler) registerAdmin(handle func(pattern string, f http.HandlerFunc)) {
	handle("GET /admin/users", h.requireAdmin(h.adminUsers))
	handle("POST /admin/users", h.requireAdmin(h.adminCreate))
	handle("POST /admin/users/{id}/reset", h.requireAdmin(h.adminReset))
	handle("POST /admin/users/{id}/disable", h.requireAdmin(h.adminAction(func(r *http.Request, u account.User) error {
		return h.accounts.SetDisabled(r.Context(), u.ID, true)
	}, "disabled")))
	handle("POST /admin/users/{id}/enable", h.requireAdmin(h.adminAction(func(r *http.Request, u account.User) error {
		return h.accounts.SetDisabled(r.Context(), u.ID, false)
	}, "enabled")))
	handle("POST /admin/users/{id}/promote", h.requireAdmin(h.adminAction(func(r *http.Request, u account.User) error {
		return h.accounts.SetAdmin(r.Context(), u.ID, true)
	}, "promoted")))
	handle("POST /admin/users/{id}/demote", h.requireAdmin(h.adminAction(func(r *http.Request, u account.User) error {
		return h.accounts.SetAdmin(r.Context(), u.ID, false)
	}, "demoted")))
	handle("POST /admin/users/{id}/signout", h.requireAdmin(h.adminAction(func(r *http.Request, u account.User) error {
		return h.accounts.RevokeAll(r.Context(), u.ID)
	}, "signed-out")))
	handle("GET /admin/users/{id}/delete", h.requireAdmin(h.adminDeleteConfirm))
	handle("POST /admin/users/{id}/delete", h.requireAdmin(h.adminAction(func(r *http.Request, u account.User) error {
		return h.accounts.Delete(r.Context(), u.ID)
	}, "deleted")))
	handle("GET /admin/{$}", h.requireAdmin(func(w http.ResponseWriter, r *http.Request, _ account.User) {
		http.Redirect(w, r, "/admin/users", http.StatusSeeOther)
	}))
}

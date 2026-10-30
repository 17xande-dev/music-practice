package account

import "context"

// CreateSession signs a user in without the credential guard SignIn applies.
// Tests only: production sign-ins must go through SignIn.
func (s *Store) CreateSession(ctx context.Context, userID int64, kind, label string) (string, Session, error) {
	return s.createSession(ctx, userID, "", false, kind, label)
}

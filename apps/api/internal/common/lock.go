package common

import "sync"

// Lock is a held key. Release is idempotent and owner-checked.
type Lock interface {
	Release()
}

type lockHandle struct {
	svc   *LockService
	key   string
	token uint64
}

// Release frees the key, but only if this holder still owns it.
//
// The ownership check is what makes a double release harmless. The sync
// orchestrator releases in a defer, and if the code path also released on a
// specific branch, the second call would otherwise free a key that a *new* run
// had since acquired -- letting two runs of the same kind run at once, which is
// the one thing this exists to prevent.
func (l *lockHandle) Release() { l.svc.release(l.key, l.token) }

// LockService is an in-process mutex, one lock per key.
//
// Scraping the upstream API is the most expensive thing this app does, and a
// second scrape of the same kind would double that cost against a public
// endpoint that answers to everybody. This is the only thing standing between
// "Sync full" and a second full backfill, so Acquire refusing while a key is
// held is the whole contract: the caller reports "already running" instead of
// starting work.
//
// ## It is per process, and the deployment depends on that.
//
// Voroa runs one container per service, which satisfies this by default -- but
// scaling a service to two instances breaks it silently. Nothing here detects
// that: both instances would scrape, and Clear could delete rows out from under
// the other instance's inserts. If the service is ever scaled out, this needs
// to become a lock in Postgres. The right shape is already there -- sync_state
// has a running_since column that survives a restart -- so that change is small,
// and it should not be left as a surprise.
//
// The keys never expire, which is the point: a lock is released in a defer, and
// if that never runs, the process that died took the lock with it. That is why
// there is no TTL, no renewal timer and no boot-time cleanup -- a lock cannot
// outlive the process that took it, so there is nothing left behind to clear.
//
// Not reentrant: acquiring a key this goroutine already holds returns nil.
type LockService struct {
	mu     sync.Mutex
	held   map[string]uint64
	issued uint64
}

// NewLockService returns an empty LockService.
func NewLockService() *LockService {
	return &LockService{held: make(map[string]uint64)}
}

// Acquire takes the key, or returns nil if it is already held.
func (s *LockService) Acquire(key string) Lock {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, busy := s.held[key]; busy {
		return nil
	}
	// Tokens are counters rather than pointers for a reason that is easy to get
	// wrong: `&struct{}{}` is a zero-sized allocation, and Go is explicitly
	// permitted to give two distinct ones the same address (they all share
	// runtime.zerobase). Comparing those by identity would make every handle
	// look like the holder of every other handle, and a stale double-release
	// would free a live lock -- exactly the failure this ownership check exists
	// to prevent.
	s.issued++
	token := s.issued
	s.held[key] = token
	return &lockHandle{svc: s, key: key, token: token}
}

// IsHeld reports whether a key is currently taken. For status display; take the
// lock rather than asking about it when you intend to do work.
func (s *LockService) IsHeld(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, busy := s.held[key]
	return busy
}

func (s *LockService) release(key string, token uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.held[key] == token {
		delete(s.held, key)
	}
}

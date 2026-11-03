CREATE TABLE accounts (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1))
);

CREATE TABLE credentials (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT
);
CREATE INDEX credentials_account ON credentials(account_id);

CREATE TABLE logins (
    id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE INDEX logins_account ON logins(account_id);
CREATE INDEX logins_expiry ON logins(expires_at);

CREATE TABLE challenges (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
    challenge TEXT NOT NULL,
    account_id TEXT,
    account_name TEXT,
    expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expiry ON challenges(expires_at);

CREATE TABLE rate_limits (
    id TEXT PRIMARY KEY NOT NULL,
    count INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);

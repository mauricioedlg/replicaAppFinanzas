CREATE TABLE app_sessions (
  session_key varchar(64) PRIMARY KEY,
  user_id bigint NOT NULL UNIQUE REFERENCES usuarios (id) ON DELETE CASCADE,
  credential_hash varchar(64) NOT NULL,
  expires_at timestamp with time zone NOT NULL
);

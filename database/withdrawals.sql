ALTER TABLE transacciones
  ALTER COLUMN tipo TYPE varchar(12),
  DROP CONSTRAINT transacciones_valid_type,
  DROP CONSTRAINT transacciones_valid_shape,
  ADD CONSTRAINT transacciones_valid_type CHECK (tipo IN ('buy', 'sell', 'deposit', 'withdrawal')),
  ADD CONSTRAINT transacciones_valid_shape CHECK (
    (tipo IN ('deposit', 'withdrawal') AND accion_id IS NULL AND cantidad = 0 AND precio_unitario = 0)
    OR (tipo IN ('buy', 'sell') AND accion_id IS NOT NULL AND cantidad > 0 AND precio_unitario > 0)
  );

CREATE TABLE payment_withdrawals (
  id uuid PRIMARY KEY,
  usuario_id bigint NOT NULL REFERENCES usuarios (id),
  card_id uuid NOT NULL REFERENCES payment_cards (id),
  request_id uuid NOT NULL,
  transaction_id bigint NOT NULL UNIQUE REFERENCES transacciones (id),
  amount numeric(18, 2) NOT NULL CHECK (amount > 0),
  created_at timestamp with time zone NOT NULL,
  UNIQUE (usuario_id, request_id)
);

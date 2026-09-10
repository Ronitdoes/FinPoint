--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  -- s-35 release hatch: the slug-guarded demo-tenant reset
  -- (packages/db/src/seeds/reset.ts) sets app.allow_audit_delete = 'on'
  -- transaction-locally so a pristine demo can be re-seeded. Default-deny is
  -- preserved on every other path: application roles still lack UPDATE/DELETE
  -- grants and no production code sets this flag.
  IF current_setting('app.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Audit records and case events are append-only and immutable. Operation % is prohibited on %.', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "public"."prevent_deletion_intent_withdrawal"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."deletion_requested_at" IS NOT NULL
    AND NEW."deletion_requested_at" IS NULL THEN
    RAISE EXCEPTION 'deletion_requested_at cannot be cleared once set'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_deletion_intent_monotonic"
BEFORE UPDATE OF "deletion_requested_at" ON "projects"
FOR EACH ROW
EXECUTE FUNCTION "public"."prevent_deletion_intent_withdrawal"();
--> statement-breakpoint
CREATE TRIGGER "source_assets_deletion_intent_monotonic"
BEFORE UPDATE OF "deletion_requested_at" ON "source_assets"
FOR EACH ROW
EXECUTE FUNCTION "public"."prevent_deletion_intent_withdrawal"();

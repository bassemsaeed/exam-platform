CREATE TABLE IF NOT EXISTS "college" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" VARCHAR(20) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "college_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "college_code_key" ON "college"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "college_name_key" ON "college"("name");
ALTER TABLE "department" ADD COLUMN IF NOT EXISTS "college_id" UUID;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "college_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'department_college_id_fkey') THEN
    ALTER TABLE "department" ADD CONSTRAINT "department_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_college_id_fkey') THEN
    ALTER TABLE "user" ADD CONSTRAINT "user_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "college"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
-- Backfill: one college per distinct free-text name (case-insensitive).
-- Codes derive from the name stem with numeric suffixes only on clash;
-- admins rename to official codes in the UI.
WITH distinct_names AS (
  SELECT lower(btrim(college)) AS key, mode() WITHIN GROUP (ORDER BY btrim(college)) AS name
  FROM "user" WHERE college IS NOT NULL AND btrim(college) <> '' GROUP BY 1
),
stemmed AS (
  SELECT key, name, NULLIF(upper(substring(regexp_replace(name, '[^A-Za-z0-9]', '', 'g') from 1 for 8)), '') AS stem
  FROM distinct_names
),
numbered AS (
  SELECT key, name, COALESCE(stem, 'C') AS s,
    row_number() OVER (PARTITION BY COALESCE(stem, 'C') ORDER BY name) AS rn,
    count(*) OVER (PARTITION BY COALESCE(stem, 'C')) AS cnt
  FROM stemmed
)
INSERT INTO college (id, code, name, created_at)
SELECT gen_random_uuid(), s || CASE WHEN cnt > 1 THEN '-' || rn::text ELSE '' END, name, now()
FROM numbered
ON CONFLICT DO NOTHING;
UPDATE "user" u SET college_id = c.id FROM college c
WHERE u.college_id IS NULL AND u.college IS NOT NULL AND lower(btrim(u.college)) = lower(c.name);

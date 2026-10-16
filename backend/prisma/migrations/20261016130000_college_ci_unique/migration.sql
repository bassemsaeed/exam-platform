-- Case-insensitive uniqueness for colleges: the app guards with a lower()
-- lookup, but the base table uniques are case-sensitive, so concurrent
-- creates ("Engineering" vs "engineering") could fork. Enforce at the DB.
CREATE UNIQUE INDEX IF NOT EXISTS "college_name_lower_key" ON "college"(lower("name"));
CREATE UNIQUE INDEX IF NOT EXISTS "college_code_lower_key" ON "college"(lower("code"));

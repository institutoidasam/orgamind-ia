-- F1 follow-up: Postgres uniqueness is case-sensitive by default. Sector names
-- are a human identifier, so normalize their unique comparison in the database.
CREATE UNIQUE INDEX "Sector_name_normalized_key" ON "Sector" (LOWER("name"));

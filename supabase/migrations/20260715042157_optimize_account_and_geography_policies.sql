-- Cover foreign keys used by geography, profile and follow lookups. The
-- partial predicates keep the indexes compact when the relation is optional.
CREATE INDEX IF NOT EXISTS cities_region_id_idx
  ON public.cities (region_id)
  WHERE region_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_home_city_id_idx
  ON public.profiles (home_city_id)
  WHERE home_city_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS venues_country_id_idx
  ON public.venues (country_id)
  WHERE country_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS organizer_members_user_id_idx
  ON public.organizer_members (user_id);

CREATE INDEX IF NOT EXISTS followed_organizers_organizer_id_idx
  ON public.followed_organizers (organizer_id);

CREATE INDEX IF NOT EXISTS followed_performers_performer_id_idx
  ON public.followed_performers (performer_id);

CREATE INDEX IF NOT EXISTS followed_venues_venue_id_idx
  ON public.followed_venues (venue_id);

-- Evaluate auth.uid() once per statement rather than once per row on the
-- account-facing policies used by every signed-in session.
DROP POLICY IF EXISTS profiles_select_own ON public.profiles;
CREATE POLICY profiles_select_own
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;
CREATE POLICY profiles_insert_own
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);

DROP POLICY IF EXISTS user_roles_select_own ON public.user_roles;
CREATE POLICY user_roles_select_own
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS fav_own_all ON public.favorites;
CREATE POLICY fav_own_all
  ON public.favorites
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS cal_own_all ON public.calendar_items;
CREATE POLICY cal_own_all
  ON public.calendar_items
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS fo_own_all ON public.followed_organizers;
CREATE POLICY fo_own_all
  ON public.followed_organizers
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS fp_own_all ON public.followed_performers;
CREATE POLICY fp_own_all
  ON public.followed_performers
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS fv_own_all ON public.followed_venues;
CREATE POLICY fv_own_all
  ON public.followed_venues
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

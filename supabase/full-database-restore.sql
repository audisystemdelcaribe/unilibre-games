-- =============================================================================
-- UNILIBRE GAMES — Restauración completa de esquema + RLS + funciones
-- =============================================================================
-- Generado desde el repositorio (migraciones + código de la app).
-- NO incluye datos de producción (preguntas, usuarios, eventos jugados).
--
-- CÓMO USAR (proyecto Supabase nuevo o recuperación):
--   1. Dashboard Supabase → SQL Editor → New query → pegar y ejecutar TODO.
--   2. O: supabase db execute -f supabase/full-database-restore.sql
--   3. Crear primer admin: Authentication → Users → Add user
--      Luego: UPDATE public.players SET role = 'admin' WHERE auth_user_id = '<uuid>';
--
-- NOTA: auth.users la gestiona Supabase Auth; este script crea el trigger
--       que inserta en public.players al registrarse.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Extensiones
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- Tablas base (orden por dependencias de FK)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.faculties (
  id serial PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.programs (
  id serial PRIMARY KEY,
  name text NOT NULL,
  faculty_id integer REFERENCES public.faculties(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.subjects (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.program_subjects (
  program_id integer NOT NULL REFERENCES public.programs(id) ON DELETE CASCADE,
  subject_id integer NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  semester integer NOT NULL DEFAULT 1,
  PRIMARY KEY (program_id, subject_id, semester)
);

CREATE TABLE IF NOT EXISTS public.seasons (
  id serial PRIMARY KEY,
  year integer NOT NULL,
  semester integer NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.game_modes (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.game_levels (
  id serial PRIMARY KEY,
  name text NOT NULL,
  difficulty_order integer NOT NULL DEFAULT 1,
  money_value numeric NOT NULL DEFAULT 0,
  points integer NOT NULL DEFAULT 100,
  time_limit integer NOT NULL DEFAULT 30,
  is_safe_level boolean NOT NULL DEFAULT false,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lifelines (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  code varchar(50),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.players (
  id serial PRIMARY KEY,
  auth_user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'player' CHECK (role IN ('admin', 'docente', 'player', 'preseleccion')),
  program_id integer REFERENCES public.programs(id) ON DELETE SET NULL,
  semester integer,
  score integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.events (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  event_date date,
  season_id integer REFERENCES public.seasons(id) ON DELETE SET NULL,
  game_mode_id integer REFERENCES public.game_modes(id) ON DELETE SET NULL,
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'faculty', 'program')),
  faculty_id integer REFERENCES public.faculties(id) ON DELETE SET NULL,
  program_id integer REFERENCES public.programs(id) ON DELETE SET NULL,
  access_code text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_rounds (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  round_number integer NOT NULL DEFAULT 0,
  type text NOT NULL DEFAULT 'classroom_quiz',
  status text NOT NULL DEFAULT 'waiting',
  classroom_group_id text,
  session_pin text,
  current_question_id integer,
  question_started_at timestamptz,
  verification_result jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.questions (
  id serial PRIMARY KEY,
  subject_id integer REFERENCES public.subjects(id) ON DELETE SET NULL,
  level_id integer REFERENCES public.game_levels(id) ON DELETE SET NULL,
  question_text text NOT NULL,
  scope text NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'faculty', 'program')),
  faculty_id integer REFERENCES public.faculties(id) ON DELETE SET NULL,
  program_id integer REFERENCES public.programs(id) ON DELETE SET NULL,
  min_semester integer NOT NULL DEFAULT 1,
  max_semester integer NOT NULL DEFAULT 10,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- FK opcional pregunta actual en ronda (se añade después de crear questions)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_rounds_current_question_id_fkey'
  ) THEN
    ALTER TABLE public.event_rounds
      ADD CONSTRAINT event_rounds_current_question_id_fkey
      FOREIGN KEY (current_question_id) REFERENCES public.questions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.answers (
  id serial PRIMARY KEY,
  question_id integer NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  answer_text text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_players (
  event_id integer NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  classroom_group_id text NOT NULL DEFAULT '',
  score integer NOT NULL DEFAULT 0,
  stage text NOT NULL DEFAULT 'lobby',
  total_time_ms integer DEFAULT 0,
  final_rank integer,
  is_finalist boolean DEFAULT false,
  joined_at timestamptz DEFAULT now(),
  PRIMARY KEY (event_id, player_id)
);

CREATE TABLE IF NOT EXISTS public.game_sessions (
  id serial PRIMARY KEY,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  event_id integer NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  round_id integer REFERENCES public.event_rounds(id) ON DELETE SET NULL,
  session_type text NOT NULL DEFAULT 'classroom',
  score integer NOT NULL DEFAULT 0,
  finished boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE (player_id, event_id, finished)
);

CREATE TABLE IF NOT EXISTS public.game_answers (
  id bigserial PRIMARY KEY,
  game_session_id integer NOT NULL REFERENCES public.game_sessions(id) ON DELETE CASCADE,
  round_id integer NOT NULL REFERENCES public.event_rounds(id) ON DELETE CASCADE,
  event_id integer NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  classroom_group_id text,
  question_id integer NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  answer_id integer NOT NULL REFERENCES public.answers(id) ON DELETE CASCADE,
  is_correct boolean NOT NULL DEFAULT false,
  response_time_ms integer NOT NULL DEFAULT 0,
  money_at_question integer NOT NULL DEFAULT 0,
  level_id integer DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fastest_finger_sequences (
  id serial PRIMARY KEY,
  title text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fastest_finger_items (
  id serial PRIMARY KEY,
  sequence_id integer NOT NULL REFERENCES public.fastest_finger_sequences(id) ON DELETE CASCADE,
  text text NOT NULL,
  correct_position integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fastest_finger_rounds (
  id serial PRIMARY KEY,
  event_round_id integer NOT NULL REFERENCES public.event_rounds(id) ON DELETE CASCADE,
  sequence_id integer NOT NULL REFERENCES public.fastest_finger_sequences(id) ON DELETE CASCADE,
  started_at timestamptz DEFAULT now(),
  UNIQUE (event_round_id)
);

CREATE TABLE IF NOT EXISTS public.fastest_finger_attempts (
  id serial PRIMARY KEY,
  fastest_finger_round_id integer NOT NULL REFERENCES public.fastest_finger_rounds(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  selected_order jsonb NOT NULL,
  response_time_ms integer NOT NULL DEFAULT 0,
  is_correct boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE (fastest_finger_round_id, player_id)
);

CREATE TABLE IF NOT EXISTS public.active_contestants (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  round_id integer REFERENCES public.event_rounds(id) ON DELETE SET NULL,
  started_at timestamptz DEFAULT now(),
  UNIQUE (event_id)
);

CREATE TABLE IF NOT EXISTS public.round_questions_shown (
  id serial PRIMARY KEY,
  round_id integer NOT NULL REFERENCES public.event_rounds(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  shown_at timestamptz DEFAULT now(),
  UNIQUE (round_id, question_id)
);

CREATE TABLE IF NOT EXISTS public.round_lifeline_usage (
  id serial PRIMARY KEY,
  round_id integer NOT NULL REFERENCES public.event_rounds(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  lifeline_code varchar(50) NOT NULL,
  metadata jsonb,
  used_at timestamptz DEFAULT now(),
  UNIQUE (round_id, question_id, lifeline_code)
);

CREATE TABLE IF NOT EXISTS public.student_answer_selection (
  id serial PRIMARY KEY,
  round_id integer NOT NULL REFERENCES public.event_rounds(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  answer_id integer NOT NULL REFERENCES public.answers(id) ON DELETE CASCADE,
  selected_at timestamptz DEFAULT now(),
  UNIQUE (round_id, question_id, player_id)
);

CREATE TABLE IF NOT EXISTS public.audience_lifeline_votes (
  id serial PRIMARY KEY,
  round_id integer NOT NULL REFERENCES public.event_rounds(id) ON DELETE CASCADE,
  question_id integer NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  answer_id integer NOT NULL REFERENCES public.answers(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE (round_id, question_id, player_id)
);

CREATE TABLE IF NOT EXISTS public.season_rankings (
  id serial PRIMARY KEY,
  season_id integer NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  player_id integer NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0,
  position integer,
  created_at timestamptz DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Índices
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_programs_faculty ON public.programs(faculty_id);
CREATE INDEX IF NOT EXISTS idx_players_auth_user ON public.players(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_players_program ON public.players(program_id);
CREATE INDEX IF NOT EXISTS idx_events_season ON public.events(season_id);
CREATE INDEX IF NOT EXISTS idx_events_game_mode ON public.events(game_mode_id);
CREATE INDEX IF NOT EXISTS idx_event_rounds_event ON public.event_rounds(event_id);
CREATE INDEX IF NOT EXISTS idx_event_rounds_pin ON public.event_rounds(session_pin);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON public.questions(subject_id);
CREATE INDEX IF NOT EXISTS idx_questions_level ON public.questions(level_id);
CREATE INDEX IF NOT EXISTS idx_answers_question ON public.answers(question_id);
CREATE INDEX IF NOT EXISTS idx_event_players_group ON public.event_players(event_id, classroom_group_id);
CREATE INDEX IF NOT EXISTS idx_game_sessions_round ON public.game_sessions(round_id);
CREATE INDEX IF NOT EXISTS idx_game_answers_round ON public.game_answers(round_id);
CREATE INDEX IF NOT EXISTS idx_round_questions_shown_round ON public.round_questions_shown(round_id);
CREATE UNIQUE INDEX IF NOT EXISTS game_answers_session_question_key
  ON public.game_answers(game_session_id, question_id);

-- -----------------------------------------------------------------------------
-- Funciones RPC / helpers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.add_player_time(
  p_player_id integer,
  p_event_id integer,
  p_response_ms integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.event_players
  SET total_time_ms = COALESCE(total_time_ms, 0) + p_response_ms
  WHERE player_id = p_player_id AND event_id = p_event_id;
$$;

CREATE OR REPLACE FUNCTION public.registrar_puntaje_ganado(
  p_session_id integer,
  p_event_id integer,
  p_player_id integer,
  p_puntos integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.game_sessions
  SET score = COALESCE(score, 0) + p_puntos
  WHERE id = p_session_id;

  UPDATE public.event_players
  SET score = COALESCE(score, 0) + p_puntos
  WHERE event_id = p_event_id AND player_id = p_player_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.insert_game_answer(
  p_game_session_id integer,
  p_round_id integer,
  p_event_id integer,
  p_player_id integer,
  p_classroom_group_id text,
  p_question_id integer,
  p_answer_id integer,
  p_is_correct boolean,
  p_response_time_ms integer,
  p_money_at_question integer,
  p_level_id integer DEFAULT 1
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id bigint;
  existing_id bigint;
BEGIN
  INSERT INTO public.game_answers (
    game_session_id, round_id, event_id, player_id, classroom_group_id,
    question_id, answer_id, is_correct, response_time_ms, money_at_question, level_id
  ) VALUES (
    p_game_session_id, p_round_id, p_event_id, p_player_id, p_classroom_group_id,
    p_question_id, p_answer_id, p_is_correct, p_response_time_ms, p_money_at_question, p_level_id
  )
  ON CONFLICT (game_session_id, question_id) DO NOTHING
  RETURNING id INTO new_id;

  IF new_id IS NULL THEN
    SELECT id INTO existing_id
    FROM public.game_answers
    WHERE game_session_id = p_game_session_id AND question_id = p_question_id
    LIMIT 1;
    RETURN existing_id;
  END IF;

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.players
    WHERE auth_user_id = auth.uid() AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.players
    WHERE auth_user_id = auth.uid() AND role IN ('admin', 'docente')
  );
$$;

-- -----------------------------------------------------------------------------
-- Trigger: crear perfil en players al registrarse en Auth
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_program_id integer;
  v_semester integer;
  v_role text;
BEGIN
  v_program_id := NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'program_id', '')), '')::integer;
  v_semester := NULLIF(trim(COALESCE(NEW.raw_user_meta_data->>'semester', '')), '')::integer;
  v_role := COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'role'), ''), 'player');

  INSERT INTO public.players (auth_user_id, name, program_id, semester, role, score)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    v_program_id,
    v_semester,
    v_role,
    0
  )
  ON CONFLICT (auth_user_id) DO UPDATE SET
    name = EXCLUDED.name,
    program_id = COALESCE(EXCLUDED.program_id, public.players.program_id),
    semester = COALESCE(EXCLUDED.semester, public.players.semester),
    role = COALESCE(EXCLUDED.role, public.players.role);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Datos semilla mínimos (modos de juego)
-- -----------------------------------------------------------------------------
INSERT INTO public.game_modes (id, name, description) VALUES
  (1, 'Preselección', 'Cuestionario por salones con ranking'),
  (2, 'Silla Caliente', 'Juego clásico por niveles (un concursante)'),
  (3, 'Mente más Rápida', 'Ordenar secuencia en el menor tiempo')
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('public.game_modes', 'id'), (SELECT COALESCE(MAX(id), 1) FROM public.game_modes));

INSERT INTO public.lifelines (name, code, description)
SELECT v.name, v.code, v.description
FROM (VALUES
  ('50:50', '5050', 'Elimina dos respuestas incorrectas'),
  ('Cambiar pregunta', 'cambiar_pregunta', 'Sustituye la pregunta actual'),
  ('Llamada', 'llamada', 'Ayuda telefónica'),
  ('Ayuda del público', 'publico', 'Votación del público')
) AS v(name, code, description)
WHERE NOT EXISTS (SELECT 1 FROM public.lifelines l WHERE l.code = v.code);

-- -----------------------------------------------------------------------------
-- Row Level Security (RLS)
-- -----------------------------------------------------------------------------
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faculties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.program_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_modes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lifelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fastest_finger_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fastest_finger_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fastest_finger_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fastest_finger_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_contestants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.round_lifeline_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_answer_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audience_lifeline_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.round_questions_shown ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_rankings ENABLE ROW LEVEL SECURITY;

-- PLAYERS
DROP POLICY IF EXISTS "players_select_own_or_admin" ON public.players;
DROP POLICY IF EXISTS "players_select_own_or_staff" ON public.players;
CREATE POLICY "players_select_own_or_staff" ON public.players
  FOR SELECT USING (auth_user_id = auth.uid() OR public.is_staff());

DROP POLICY IF EXISTS "players_update_admin_only" ON public.players;
CREATE POLICY "players_update_admin_only" ON public.players
  FOR UPDATE USING (public.is_admin());

DROP POLICY IF EXISTS "players_delete_admin_only" ON public.players;
CREATE POLICY "players_delete_admin_only" ON public.players
  FOR DELETE USING (public.is_admin());

-- PROGRAMS, FACULTIES, SUBJECTS, SEASONS
DROP POLICY IF EXISTS "programs_select_authenticated" ON public.programs;
CREATE POLICY "programs_select_authenticated" ON public.programs
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "faculties_select_authenticated" ON public.faculties;
CREATE POLICY "faculties_select_authenticated" ON public.faculties
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "subjects_select_authenticated" ON public.subjects;
CREATE POLICY "subjects_select_authenticated" ON public.subjects
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "seasons_select_authenticated" ON public.seasons;
CREATE POLICY "seasons_select_authenticated" ON public.seasons
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "program_subjects_select_authenticated" ON public.program_subjects;
CREATE POLICY "program_subjects_select_authenticated" ON public.program_subjects
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "programs_all_admin" ON public.programs;
CREATE POLICY "programs_all_admin" ON public.programs FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "faculties_all_admin" ON public.faculties;
CREATE POLICY "faculties_all_admin" ON public.faculties FOR ALL USING (public.is_admin());

-- GAME_LEVELS, GAME_MODES, LIFELINES
DROP POLICY IF EXISTS "game_levels_select_authenticated" ON public.game_levels;
CREATE POLICY "game_levels_select_authenticated" ON public.game_levels
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "game_modes_select_authenticated" ON public.game_modes;
CREATE POLICY "game_modes_select_authenticated" ON public.game_modes
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "lifelines_select_authenticated" ON public.lifelines;
CREATE POLICY "lifelines_select_authenticated" ON public.lifelines
  FOR SELECT USING (auth.role() = 'authenticated');

-- EVENTS
DROP POLICY IF EXISTS "events_select_authenticated" ON public.events;
CREATE POLICY "events_select_authenticated" ON public.events
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "events_insert_update_staff" ON public.events;
CREATE POLICY "events_insert_update_staff" ON public.events
  FOR ALL USING (public.is_staff());

-- EVENT_ROUNDS
DROP POLICY IF EXISTS "event_rounds_select_authenticated" ON public.event_rounds;
CREATE POLICY "event_rounds_select_authenticated" ON public.event_rounds
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "event_rounds_insert_update_staff" ON public.event_rounds;
CREATE POLICY "event_rounds_insert_update_staff" ON public.event_rounds
  FOR ALL USING (public.is_staff());

-- EVENT_PLAYERS
DROP POLICY IF EXISTS "event_players_select_authenticated" ON public.event_players;
CREATE POLICY "event_players_select_authenticated" ON public.event_players
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "event_players_insert_update_authenticated" ON public.event_players;
CREATE POLICY "event_players_insert_update_authenticated" ON public.event_players
  FOR ALL USING (auth.role() = 'authenticated');

-- GAME_SESSIONS
DROP POLICY IF EXISTS "game_sessions_select_by_player" ON public.game_sessions;
CREATE POLICY "game_sessions_select_by_player" ON public.game_sessions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.players
      WHERE players.id = game_sessions.player_id AND players.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "game_sessions_insert_own" ON public.game_sessions;
CREATE POLICY "game_sessions_insert_own" ON public.game_sessions
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.players
      WHERE players.id = game_sessions.player_id AND players.auth_user_id = auth.uid()
    )
  );

-- QUESTIONS, ANSWERS
DROP POLICY IF EXISTS "questions_select_authenticated" ON public.questions;
CREATE POLICY "questions_select_authenticated" ON public.questions
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "questions_all_staff" ON public.questions;
CREATE POLICY "questions_all_staff" ON public.questions
  FOR ALL USING (public.is_staff());

DROP POLICY IF EXISTS "answers_select_authenticated" ON public.answers;
CREATE POLICY "answers_select_authenticated" ON public.answers
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "answers_all_staff" ON public.answers;
CREATE POLICY "answers_all_staff" ON public.answers
  FOR ALL USING (public.is_staff());

-- GAME_ANSWERS
DROP POLICY IF EXISTS "game_answers_select_staff" ON public.game_answers;
CREATE POLICY "game_answers_select_staff" ON public.game_answers
  FOR SELECT USING (public.is_staff());

DROP POLICY IF EXISTS "game_answers_insert_own" ON public.game_answers;
CREATE POLICY "game_answers_insert_own" ON public.game_answers
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.players
      WHERE players.id = game_answers.player_id AND players.auth_user_id = auth.uid()
    )
  );

-- FASTEST FINGER
DROP POLICY IF EXISTS "fastest_finger_sequences_select_authenticated" ON public.fastest_finger_sequences;
CREATE POLICY "fastest_finger_sequences_select_authenticated" ON public.fastest_finger_sequences
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fastest_finger_sequences_all_admin" ON public.fastest_finger_sequences;
CREATE POLICY "fastest_finger_sequences_all_admin" ON public.fastest_finger_sequences
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "fastest_finger_items_select_authenticated" ON public.fastest_finger_items;
CREATE POLICY "fastest_finger_items_select_authenticated" ON public.fastest_finger_items
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fastest_finger_items_all_admin" ON public.fastest_finger_items;
CREATE POLICY "fastest_finger_items_all_admin" ON public.fastest_finger_items
  FOR ALL USING (public.is_admin());

DROP POLICY IF EXISTS "fastest_finger_rounds_select_authenticated" ON public.fastest_finger_rounds;
CREATE POLICY "fastest_finger_rounds_select_authenticated" ON public.fastest_finger_rounds
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "fastest_finger_rounds_all_staff" ON public.fastest_finger_rounds;
CREATE POLICY "fastest_finger_rounds_all_staff" ON public.fastest_finger_rounds
  FOR ALL USING (public.is_staff());

DROP POLICY IF EXISTS "fastest_finger_attempts_select_staff" ON public.fastest_finger_attempts;
CREATE POLICY "fastest_finger_attempts_select_staff" ON public.fastest_finger_attempts
  FOR SELECT USING (public.is_staff());

DROP POLICY IF EXISTS "active_contestants_select_staff" ON public.active_contestants;
CREATE POLICY "active_contestants_select_staff" ON public.active_contestants
  FOR SELECT USING (public.is_staff());

DROP POLICY IF EXISTS "active_contestants_all_staff" ON public.active_contestants;
CREATE POLICY "active_contestants_all_staff" ON public.active_contestants
  FOR ALL USING (public.is_staff());

-- ROUND_LIFELINE_USAGE
DROP POLICY IF EXISTS "round_lifeline_usage_select_authenticated" ON public.round_lifeline_usage;
CREATE POLICY "round_lifeline_usage_select_authenticated" ON public.round_lifeline_usage
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "round_lifeline_usage_insert_staff" ON public.round_lifeline_usage;
CREATE POLICY "round_lifeline_usage_insert_staff" ON public.round_lifeline_usage
  FOR INSERT WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "round_lifeline_usage_update_staff" ON public.round_lifeline_usage;
CREATE POLICY "round_lifeline_usage_update_staff" ON public.round_lifeline_usage
  FOR UPDATE USING (public.is_staff());

-- STUDENT_ANSWER_SELECTION
DROP POLICY IF EXISTS "student_answer_selection_select" ON public.student_answer_selection;
CREATE POLICY "student_answer_selection_select" ON public.student_answer_selection
  FOR SELECT USING (
    public.is_staff()
    OR EXISTS (
      SELECT 1 FROM public.players
      WHERE players.id = student_answer_selection.player_id AND players.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "student_answer_selection_insert_own" ON public.student_answer_selection;
CREATE POLICY "student_answer_selection_insert_own" ON public.student_answer_selection
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.players
      WHERE players.id = student_answer_selection.player_id AND players.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "student_answer_selection_update_own" ON public.student_answer_selection;
CREATE POLICY "student_answer_selection_update_own" ON public.student_answer_selection
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.players
      WHERE players.id = student_answer_selection.player_id AND players.auth_user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "student_answer_selection_delete_staff" ON public.student_answer_selection;
CREATE POLICY "student_answer_selection_delete_staff" ON public.student_answer_selection
  FOR DELETE USING (public.is_staff());

-- AUDIENCE_LIFELINE_VOTES
DROP POLICY IF EXISTS "audience_lifeline_votes_select_authenticated" ON public.audience_lifeline_votes;
CREATE POLICY "audience_lifeline_votes_select_authenticated" ON public.audience_lifeline_votes
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "audience_lifeline_votes_insert_own" ON public.audience_lifeline_votes;
CREATE POLICY "audience_lifeline_votes_insert_own" ON public.audience_lifeline_votes
  FOR INSERT WITH CHECK (
    auth.role() = 'authenticated'
    AND player_id IN (SELECT id FROM public.players WHERE auth_user_id = auth.uid())
  );

DROP POLICY IF EXISTS "audience_lifeline_votes_update_own" ON public.audience_lifeline_votes;
CREATE POLICY "audience_lifeline_votes_update_own" ON public.audience_lifeline_votes
  FOR UPDATE USING (
    auth.role() = 'authenticated'
    AND player_id IN (SELECT id FROM public.players WHERE auth_user_id = auth.uid())
  );

-- ROUND_QUESTIONS_SHOWN, SEASON_RANKINGS
DROP POLICY IF EXISTS "round_questions_shown_select_authenticated" ON public.round_questions_shown;
CREATE POLICY "round_questions_shown_select_authenticated" ON public.round_questions_shown
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "round_questions_shown_all_staff" ON public.round_questions_shown;
CREATE POLICY "round_questions_shown_all_staff" ON public.round_questions_shown
  FOR ALL USING (public.is_staff());

DROP POLICY IF EXISTS "season_rankings_select_authenticated" ON public.season_rankings;
CREATE POLICY "season_rankings_select_authenticated" ON public.season_rankings
  FOR SELECT USING (auth.role() = 'authenticated');

-- -----------------------------------------------------------------------------
-- Permisos para roles de Supabase
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, service_role;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- =============================================================================
-- FIN — Verifica en Table Editor que existan las tablas.
-- reset-prueba.sql sigue disponible para vaciar solo datos de partidas.
-- =============================================================================

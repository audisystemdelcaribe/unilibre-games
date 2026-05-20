-- Corrige "duplicate key" al crear preguntas/respuestas tras importar datos con IDs explícitos.
CREATE OR REPLACE FUNCTION public.sync_questions_answers_sequences()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q_seq text;
  a_seq text;
  q_max bigint;
  a_max bigint;
BEGIN
  q_seq := pg_get_serial_sequence('public.questions', 'id');
  a_seq := pg_get_serial_sequence('public.answers', 'id');

  IF q_seq IS NOT NULL THEN
    SELECT COALESCE(MAX(id), 0) INTO q_max FROM public.questions;
    PERFORM setval(q_seq, q_max, true);
  END IF;

  IF a_seq IS NOT NULL THEN
    SELECT COALESCE(MAX(id), 0) INTO a_max FROM public.answers;
    PERFORM setval(a_seq, a_max, true);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_questions_answers_sequences() TO service_role;

import { facultiesActions } from './modules/faculties.ts';
import { programsActions } from './modules/programs.ts';
import { subjectsActions } from './modules/subjects.ts';
import { seasonsActions } from './modules/seasons.ts';
import { gameLevelsActions } from './modules/game_levels.ts';
import { lifelinesActions } from './modules/lifelines.ts';
import { gameModesActions } from './modules/game_modes.ts';
import { questionsActions } from './modules/questions.ts';
import { fastestFingerActions } from './modules/fastest_finger.ts';
import { eventsActions } from './modules/events.ts';
import { liveSessionsActions } from './modules/live_sessions.ts';
import { usersActions } from './modules/users.ts';
import { authActions } from './modules/auth.ts';
import { finalistsActions } from './modules/finalists.ts';

export const server = {
    ...facultiesActions,
    ...programsActions,
    ...subjectsActions,
    ...seasonsActions,
    ...gameLevelsActions,
    ...lifelinesActions,
    ...gameModesActions,
    ...questionsActions,
    ...fastestFingerActions,
    ...eventsActions,
    ...liveSessionsActions,
    ...usersActions,
    ...authActions,
    ...finalistsActions
};
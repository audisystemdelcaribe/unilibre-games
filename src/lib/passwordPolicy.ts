/** Requisitos alineados con Supabase Auth (seguridad reforzada en el panel). */
export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_REQUIREMENTS_MSG =
    `Mínimo ${PASSWORD_MIN_LENGTH} caracteres, con al menos: una mayúscula (A-Z), una minúscula (a-z), un número (0-9) y un símbolo (!@#$%^&* etc.).`;

/** Solo caracteres imprimibles ASCII (evita emojis y caracteres raros que Supabase rechaza). */
const ASCII_PRINTABLE = /^[\x21-\x7E]+$/;

const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
/** Símbolos habituales aceptados por Supabase (no solo letras ni números). */
const HAS_SYMBOL = /[^A-Za-z0-9]/;

export type PasswordCheck = { ok: true } | { ok: false; message: string };

export function validatePassword(password: string): PasswordCheck {
    const p = password ?? "";

    if (p.length < PASSWORD_MIN_LENGTH) {
        return {
            ok: false,
            message: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`,
        };
    }

    if (!ASCII_PRINTABLE.test(p)) {
        return {
            ok: false,
            message:
                "Usa solo letras, números y símbolos del teclado (sin espacios ni emojis). " +
                PASSWORD_REQUIREMENTS_MSG,
        };
    }

    if (!HAS_LOWER.test(p)) {
        return { ok: false, message: "Incluye al menos una letra minúscula (a-z)." };
    }

    if (!HAS_UPPER.test(p)) {
        return { ok: false, message: "Incluye al menos una letra mayúscula (A-Z)." };
    }

    if (!HAS_DIGIT.test(p)) {
        return { ok: false, message: "Incluye al menos un número (0-9)." };
    }

    if (!HAS_SYMBOL.test(p)) {
        return {
            ok: false,
            message: "Incluye al menos un símbolo, por ejemplo: ! @ # $ % * _ -",
        };
    }

    return { ok: true };
}

/** Mensaje legible para errores devueltos por Supabase Auth. */
export function mapSupabasePasswordError(raw: string): string {
    const msg = raw || "";

    if (/leaked|pwned|breach|compromised|filtrada/i.test(msg)) {
        return "Esa contraseña es muy común o apareció en filtraciones. Elige otra distinta.";
    }

    if (/at least \d+ characters|minimum.*\d+.*character|al menos \d+ caracter/i.test(msg)) {
        return `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres. ${PASSWORD_REQUIREMENTS_MSG}`;
    }

    if (/uppercase|mayúscula|upper case/i.test(msg)) {
        return "Incluye al menos una letra mayúscula (A-Z).";
    }

    if (/lowercase|minúscula|lower case/i.test(msg)) {
        return "Incluye al menos una letra minúscula (a-z).";
    }

    if (/number|digit|número|numeric/i.test(msg)) {
        return "Incluye al menos un número (0-9).";
    }

    if (/symbol|special|símbolo|caracter especial/i.test(msg)) {
        return "Incluye al menos un símbolo, por ejemplo: ! @ # $ % * _ -";
    }

    if (/weak|débil|requirement|requisito|invalid password|contraseña/i.test(msg)) {
        return `La contraseña no cumple los requisitos de seguridad. ${PASSWORD_REQUIREMENTS_MSG}`;
    }

    return msg || `La contraseña no cumple los requisitos. ${PASSWORD_REQUIREMENTS_MSG}`;
}

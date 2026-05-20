const INSTITUTIONAL_DOMAIN = "@unilibre.edu.co";

export function normalizeInstitutionalEmail(raw: string): { email: string } | { error: string } {
    let email = raw.trim().toLowerCase();

    if (!email) {
        return { error: "Ingresa tu correo institucional" };
    }

    if (!email.includes("@")) {
        email = `${email}${INSTITUTIONAL_DOMAIN}`;
    }

    if (!email.endsWith(INSTITUTIONAL_DOMAIN)) {
        return { error: "Debes usar tu correo institucional (@unilibre.edu.co)" };
    }

    return { email };
}

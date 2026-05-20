import { z } from "astro:schema";
import { PASSWORD_REQUIREMENTS_MSG, validatePassword } from "./passwordPolicy";

export function passwordFieldSchema(fieldLabel = "La contraseña") {
    return z
        .string()
        .min(1, `${fieldLabel} es obligatoria`)
        .superRefine((val, ctx) => {
            const check = validatePassword(val);
            if (!check.ok) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: check.message,
                });
            }
        });
}

export { PASSWORD_REQUIREMENTS_MSG };

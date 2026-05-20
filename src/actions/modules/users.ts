import { defineAction } from 'astro:actions';
import { z } from 'astro:schema';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ensureAdmin } from '@/actions/utils';

async function getOwnPlayer(context: any) {
    const user = await context.locals.getUser();
    if (!user) throw new Error("Debes iniciar sesión");
    const { data: profile } = await context.locals.supabase
        .from('players')
        .select('id')
        .eq('auth_user_id', user.id)
        .single();
    if (!profile?.id) throw new Error("Perfil no encontrado");
    return { user, playerId: profile.id };
}

export const usersActions = {
    updateMyProfile: defineAction({
        accept: 'form',
        input: z.object({
            full_name: z.string().min(3, "Nombre debe tener al menos 3 caracteres"),
            program_id: z.string(),
            semester: z.string().refine((v) => !isNaN(parseInt(v)) && parseInt(v) >= 1 && parseInt(v) <= 12, "Semestre entre 1 y 12"),
        }),
        handler: async (input, context) => {
            const { playerId } = await getOwnPlayer(context);
            const { full_name, program_id, semester } = input;

            const { error } = await supabaseAdmin
                .from('players')
                .update({ name: full_name, program_id: parseInt(program_id), semester: parseInt(semester) })
                .eq('id', playerId);

            if (error) throw new Error(error.message);
            return { success: true, message: "Perfil actualizado correctamente" };
        },
    }),

    changeMyPassword: defineAction({
        accept: 'form',
        input: z.object({
            new_password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
            confirm_password: z.string(),
        }).refine((data) => data.new_password === data.confirm_password, {
            message: "Las contraseñas no coinciden",
            path: ["confirm_password"],
        }),
        handler: async (input, context) => {
            const { user } = await getOwnPlayer(context);

            const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
                password: input.new_password,
            });

            if (error) throw new Error(error.message);
            return { success: true, message: "Contraseña actualizada correctamente" };
        },
    }),

    updateUserRole: defineAction({
        accept: 'form',
        input: z.object({
            player_id: z.string(),
            role: z.enum(['admin', 'docente', 'player', 'preseleccion']),
        }),
        handler: async ({ player_id, role }, context) => {
            await ensureAdmin(context);

            const { error } = await supabaseAdmin
                .from('players')
                .update({ role })
                .eq('id', parseInt(player_id));

            if (error) throw new Error(error.message);
            return { success: true, message: "Rol actualizado correctamente" };
        }
    }),

    updatePlayer: defineAction({
        accept: 'form',
        input: z.object({
            player_id: z.string(),
            name: z.string().min(3, "Nombre debe tener al menos 3 caracteres"),
            program_id: z.string(),
            semester: z.string().refine((v) => !isNaN(parseInt(v)) && parseInt(v) >= 1 && parseInt(v) <= 12, "Semestre entre 1 y 12"),
        }),
        handler: async ({ player_id, name, program_id, semester }, context) => {
            await ensureAdmin(context);

            const { error } = await supabaseAdmin
                .from('players')
                .update({ name, program_id: parseInt(program_id), semester: parseInt(semester) })
                .eq('id', parseInt(player_id));

            if (error) throw new Error(error.message);
            return { success: true, message: "Usuario actualizado correctamente" };
        }
    }),

    changePassword: defineAction({
        accept: 'form',
        input: z.object({
            player_id: z.string(),
            new_password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
        }),
        handler: async ({ player_id, new_password }, context) => {
            await ensureAdmin(context);

            const { data: player, error: playerError } = await supabaseAdmin
                .from('players')
                .select('auth_user_id')
                .eq('id', parseInt(player_id))
                .single();

            if (playerError || !player?.auth_user_id) {
                throw new Error("Usuario no encontrado");
            }

            const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(player.auth_user_id, {
                password: new_password
            });

            if (authError) throw new Error(authError.message);
            return { success: true, message: "Contraseña cambiada correctamente" };
        }
    }),

    deleteUser: defineAction({
        accept: 'form',
        input: z.object({ player_id: z.string() }),
        handler: async ({ player_id }, context) => {
            await ensureAdmin(context);

            const { data: player, error: playerError } = await supabaseAdmin
                .from('players')
                .select('auth_user_id')
                .eq('id', parseInt(player_id))
                .single();

            if (playerError || !player?.auth_user_id) {
                throw new Error("Usuario no encontrado");
            }

            const { error: delErr } = await supabaseAdmin.from('players').delete().eq('id', parseInt(player_id));
            if (delErr) throw new Error(delErr.message);

            const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(player.auth_user_id);
            if (authErr) throw new Error(authErr.message);

            return { success: true, message: "Usuario eliminado correctamente" };
        }
    }),

    createUser: defineAction({
        accept: 'form',
        input: z.object({
            email: z.string().email("Correo inválido").refine((e) => e.endsWith("@unilibre.edu.co"), {
                message: "Debe ser un correo institucional (@unilibre.edu.co)",
            }),
            password: z.string().min(6, "La contraseña debe tener al menos 6 caracteres"),
            name: z.string().min(3, "Nombre debe tener al menos 3 caracteres"),
            program_id: z.string(),
            semester: z.string().refine(
                (v) => !isNaN(parseInt(v)) && parseInt(v) >= 1 && parseInt(v) <= 12,
                "Semestre entre 1 y 12"
            ),
            role: z.enum(['admin', 'docente', 'player', 'preseleccion']),
        }),
        handler: async (input, context) => {
            await ensureAdmin(context);

            const email = input.email.trim().toLowerCase();
            const programId = parseInt(input.program_id);
            const semester = parseInt(input.semester);

            const { data: programExists } = await supabaseAdmin
                .from("programs")
                .select("id")
                .eq("id", programId)
                .single();
            if (!programExists) {
                throw new Error("El programa seleccionado no existe");
            }

            const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                email,
                password: input.password,
                email_confirm: true,
                user_metadata: {
                    full_name: input.name,
                    program_id: programId,
                    semester,
                    role: input.role,
                },
            });

            if (authError) {
                if (/already|registered|exists|duplicate/i.test(authError.message)) {
                    throw new Error("Ya existe un usuario con ese correo");
                }
                throw new Error(authError.message);
            }

            const authUserId = authData.user?.id;
            if (!authUserId) throw new Error("No se pudo crear la cuenta de acceso");

            const playerPayload = {
                auth_user_id: authUserId,
                name: input.name,
                program_id: programId,
                semester,
                role: input.role,
            };

            const { data: existing } = await supabaseAdmin
                .from("players")
                .select("id")
                .eq("auth_user_id", authUserId)
                .maybeSingle();

            if (existing?.id) {
                const { error: updateErr } = await supabaseAdmin
                    .from("players")
                    .update(playerPayload)
                    .eq("id", existing.id);
                if (updateErr) throw new Error(updateErr.message);
            } else {
                const { error: insertErr } = await supabaseAdmin.from("players").insert(playerPayload);
                if (insertErr) throw new Error(insertErr.message);
            }

            return { success: true, message: `Usuario ${input.name} creado correctamente` };
        },
    }),

};
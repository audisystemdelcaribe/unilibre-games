<script lang="ts">
    import * as AlertDialog from "$lib/components/ui/alert-dialog";
    import { Button } from "$lib/components/ui/button";
    import { Trash2, Loader2 } from "lucide-svelte";
    import { actions } from "astro:actions";

    let { facultyId, facultyName } = $props();
    let isOpen = $state(false);
    let isDeleting = $state(false);
 
    async function handleDelete() {
        isDeleting = true;
        const { error } = await actions.deleteFaculty({ id: facultyId });
        if (!error) {
            window.location.reload();
        } else {
            alert(error.message);
            isDeleting = false;
            isOpen = false;
        }
    }
</script>

<Button variant="ghost" size="icon" onclick={() => (isOpen = true)} class="text-zinc-400 hover:text-red-600">
    <Trash2 size={18} />
</Button>

<AlertDialog.Root bind:open={isOpen}>
    <AlertDialog.Content class="border-zinc-800 bg-zinc-950 text-white backdrop-blur-xl">
        <AlertDialog.Header>
            <AlertDialog.Title class="text-red-500">¿ELIMINAR {facultyName.toUpperCase()}?</AlertDialog.Title>
            <AlertDialog.Description>Esta acción no se puede deshacer.</AlertDialog.Description>
        </AlertDialog.Header>
        <AlertDialog.Footer>
            <Button variant="ghost" onclick={() => (isOpen = false)}>Cancelar</Button>
            <Button onclick={handleDelete} disabled={isDeleting} class="bg-red-600 text-white">
                {isDeleting ? 'Borrando...' : 'Confirmar'}
            </Button>
        </AlertDialog.Footer>
    </AlertDialog.Content>
</AlertDialog.Root>
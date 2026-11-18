import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useLanguage } from "@/runtime/i18n/language"

/** The last stop before a project and its folder are permanently removed. */
export function DialogEraseProject(props: { name: string; path: string; onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  const confirm = () => {
    dialog.close()
    props.onConfirm()
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup
          title={language.t("home.project.erase.title")}
          description={language.t("home.project.erase.description", { name: props.name })}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5 rounded-2xl border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-4 py-3">
          <span class="text-11-medium uppercase tracking-wide text-v2-text-text-faint">
            {language.t("home.project.erase.folder")}
          </span>
          <code class="break-all font-mono text-12-regular text-v2-text-text-base" dir="ltr">
            {props.path}
          </code>
        </div>
        <p class="text-12-regular leading-5 text-v2-text-text-muted">{language.t("home.project.erase.warning")}</p>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" autofocus onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="danger" onClick={confirm}>
          {language.t("home.project.erase.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

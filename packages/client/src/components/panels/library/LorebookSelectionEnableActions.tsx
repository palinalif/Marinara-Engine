// ──────────────────────────────────────────────
// Selection bar extras for the Lorebooks panel:
// "Enable" and "Disable" for the selected lorebooks,
// with an Undo on the notice (like the folder switch).
// ──────────────────────────────────────────────
import { useCallback } from "react";
import { Power, PowerOff } from "lucide-react";
import { toast } from "sonner";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useSetLorebooksEnabled } from "../../../hooks/use-lorebooks";

interface LorebookSelectionEnableActionsProps {
  selectedIds: ReadonlySet<string>;
}

export function LorebookSelectionEnableActions({ selectedIds }: LorebookSelectionEnableActionsProps) {
  const { t: localizeUi } = useUiTranslation();
  const setEnabled = useSetLorebooksEnabled();

  const showError = useCallback(
    (error: unknown) =>
      toast.error(
        error instanceof Error ? error.message : localizeUi("ui.panels.lorebookspanel.couldNotSwitchLorebooks"),
      ),
    [localizeUi],
  );

  const apply = useCallback(
    async (ids: string[], enable: boolean) => {
      if (ids.length === 0) return;
      let changedIds: string[];
      try {
        changedIds = (await setEnabled.mutateAsync({ ids, enabled: enable })).changedIds;
      } catch (error) {
        showError(error);
        return;
      }
      if (changedIds.length === 0) return;
      toast.success(
        localizeUi(
          enable
            ? "ui.panels.lorebookspanel.enabledSelectedLorebooks"
            : "ui.panels.lorebookspanel.disabledSelectedLorebooks",
          { count: changedIds.length },
        ),
        {
          action: {
            label: localizeUi("ui.chat.chatresourcedropoverlay.undo"),
            // Undo flips back exactly the lorebooks this action changed.
            onClick: () => setEnabled.mutate({ ids: changedIds, enabled: !enable }, { onError: showError }),
          },
        },
      );
    },
    [localizeUi, setEnabled, showError],
  );

  const enableLabel = localizeUi("ui.panels.lorebookspanel.enableSelectedLorebooks");
  const disableLabel = localizeUi("ui.panels.lorebookspanel.disableSelectedLorebooks");
  return (
    <>
      <button
        type="button"
        data-lorebook-selection-enable="enable"
        onClick={() => void apply(Array.from(selectedIds), true)}
        disabled={setEnabled.isPending || selectedIds.size === 0}
        className="mari-chrome-control min-w-0 flex-1 px-2 py-2 text-xs"
        title={enableLabel}
        aria-label={enableLabel}
      >
        <Power size="0.75rem" className="shrink-0" />
        <span className="truncate max-[400px]:sr-only">{localizeUi("ui.panels.lorebookspanel.enable")}</span>
      </button>
      <button
        type="button"
        data-lorebook-selection-enable="disable"
        onClick={() => void apply(Array.from(selectedIds), false)}
        disabled={setEnabled.isPending || selectedIds.size === 0}
        className="mari-chrome-control min-w-0 flex-1 px-2 py-2 text-xs"
        title={disableLabel}
        aria-label={disableLabel}
      >
        <PowerOff size="0.75rem" className="shrink-0" />
        <span className="truncate max-[400px]:sr-only">{localizeUi("ui.panels.lorebookspanel.disable")}</span>
      </button>
    </>
  );
}

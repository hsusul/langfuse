import { type SessionViewConfig } from "@langfuse/shared";
import { Accordion } from "@/src/components/design-system/Accordion/Accordion";
import { Button } from "@/src/components/design-system/Button/Button";
import { DialogController } from "@/src/components/design-system/DialogController/DialogController";
import { SessionCustomizationDialog } from "@/src/features/sessions/SessionCustomizationDialog/SessionCustomizationDialog";

export function AnnotationQueueSessionViewSettings({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  value: SessionViewConfig | null;
  onChange: (value: SessionViewConfig | null) => void;
  disabled: boolean;
}) {
  const viewModeLabel = value?.viewMode === "list" ? "List" : "Conversational";
  const unmatchedTracesLabel =
    value?.unmatchedTraces === "hide" ? "Hide" : "Show";

  return (
    <Accordion type="single" collapsible>
      <Accordion.Item value="advanced">
        <Accordion.Trigger size="sm">Advanced</Accordion.Trigger>
        <Accordion.Content>
          <div className="flex flex-col gap-3 py-3">
            <h3 className="text-sm font-bold">Session view</h3>
            <p className="text-muted-foreground text-xs">
              Configure the redesigned session view for everyone annotating this
              queue. Applies to conversational and list views when the
              redesigned session view is enabled. The legacy session view is
              unchanged. Changes to saved views do not affect this
              configuration.
            </p>
            <p className="text-sm">
              {value
                ? `${viewModeLabel} · ${value.filters.length} observation filters · ${unmatchedTracesLabel} unmatched traces`
                : "Default session view"}
            </p>
            <div className="flex flex-wrap gap-2">
              <DialogController
                renderDialog={({ closeDialog }) => (
                  <SessionCustomizationDialog
                    projectId={projectId}
                    variant={{ type: "configure" }}
                    initialFilters={value?.filters ?? []}
                    initialViewMode={value?.viewMode ?? "conversational"}
                    initialUnmatchedTraces={value?.unmatchedTraces ?? "show"}
                    onApply={({ filters, viewMode, unmatchedTraces }) => {
                      onChange({ filters, viewMode, unmatchedTraces });
                      closeDialog();
                    }}
                  />
                )}
              >
                {({ openDialog }) => (
                  <Button
                    text="Configure session view"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => openDialog()}
                  />
                )}
              </DialogController>
              {value && (
                <Button
                  text="Use defaults"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => onChange(null)}
                />
              )}
            </div>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    </Accordion>
  );
}

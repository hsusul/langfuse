import { Accordion } from "@/src/components/design-system/Accordion/Accordion";
import { Button } from "@/src/components/design-system/Button/Button";
import { DialogController } from "@/src/components/design-system/DialogController/DialogController";
import { SelectInput } from "@/src/components/design-system/SelectInput/SelectInput";
import { Skeleton } from "@/src/components/ui/skeleton";
import { useHasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { usePostHogClientCapture } from "@/src/features/posthog-analytics/usePostHogClientCapture";
import { SessionCustomizationDialog } from "@/src/features/sessions/SessionCustomizationDialog/SessionCustomizationDialog";
import { api, type RouterOutputs } from "@/src/utils/api";

export function ConnectedAnnotationQueueSessionViewSettings({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const canReadViews = useHasProjectAccess({
    projectId,
    scope: "TableViewPresets:read",
  });
  const canSaveViews = useHasProjectAccess({
    projectId,
    scope: "TableViewPresets:CUD",
  });
  const views = api.sessionViews.list.useQuery(
    { projectId },
    { enabled: canReadViews },
  );
  const createView = api.sessionViews.create.useMutation();
  const updateView = api.sessionViews.update.useMutation();
  const utils = api.useUtils();
  const capture = usePostHogClientCapture();
  const selectedView = views.data?.find((view) => view.id === value);

  return (
    <DialogController<
      | { type: "create" }
      | {
          type: "edit";
          view: RouterOutputs["sessionViews"]["list"][number];
        }
    >
      renderDialog={({ state, closeDialog }) => (
        <SessionCustomizationDialog
          projectId={projectId}
          variant={{
            type: state.type,
            initialName: state.type === "edit" ? state.view.name : "",
            pending: createView.isPending || updateView.isPending,
            disabled:
              disabled ||
              !canSaveViews ||
              (state.type === "edit" && !state.view.canEdit),
            error: createView.error?.message ?? updateView.error?.message,
          }}
          initialFilters={state.type === "edit" ? state.view.filters : []}
          initialViewMode={
            state.type === "edit" ? state.view.viewMode : "conversational"
          }
          initialUnmatchedTraces={
            state.type === "edit" ? state.view.unmatchedTraces : "show"
          }
          onApply={async (configuration) => {
            if (
              disabled ||
              !canSaveViews ||
              createView.isPending ||
              updateView.isPending ||
              (state.type === "edit" && !state.view.canEdit)
            )
              return;
            try {
              const input = { ...configuration, projectId };
              const result =
                state.type === "edit"
                  ? await updateView.mutateAsync({
                      ...input,
                      id: state.view.id,
                    })
                  : await createView.mutateAsync(input);
              capture(
                state.type === "edit"
                  ? "saved_views:update_config"
                  : "saved_views:create",
                {
                  tableName: "session-detail",
                  surface: "annotation_queue",
                  isV4: true,
                  filterCount: configuration.filters.length,
                  viewMode: configuration.viewMode,
                  unmatchedTraces: configuration.unmatchedTraces,
                },
              );
              await Promise.all([
                utils.sessionViews.list.invalidate({ projectId }),
                utils.sessionViews.preferences.invalidate({ projectId }),
                utils.annotationQueues.invalidate(),
              ]);
              onChange(result.view.id);
              closeDialog();
            } catch {
              // Mutation errors remain in the dialog so saving can be retried.
            }
          }}
        />
      )}
    >
      {({ openDialog }) => (
        <Accordion type="single" collapsible>
          <Accordion.Item value="session-view">
            <Accordion.Trigger size="sm">Session view</Accordion.Trigger>
            <Accordion.Content>
              <div className="flex flex-col gap-3 py-3">
                <p className="text-muted-foreground text-xs">
                  Choose how sessions appear for everyone annotating this queue.
                </p>
                {!canReadViews && (
                  <p className="text-muted-foreground text-xs">
                    You don&apos;t have permission to choose saved views.
                  </p>
                )}
                {canReadViews && views.isPending && (
                  <Skeleton className="h-9 w-full" />
                )}
                {canReadViews && views.isError && (
                  <div className="flex items-center gap-2">
                    <p role="alert" className="text-destructive text-xs">
                      Could not load saved views.
                    </p>
                    <Button
                      text="Retry"
                      variant="ghost"
                      onClick={() => views.refetch()}
                    />
                  </div>
                )}
                {canReadViews && views.isSuccess && (
                  <div className="ph-no-capture">
                    <SelectInput
                      aria-label="Session view"
                      placeholder="Select a session view"
                      value={value ?? "default"}
                      options={[
                        { value: "default", label: "Default session view" },
                        ...(views.data ?? []).map((view) => ({
                          value: view.id,
                          label: view.name,
                        })),
                      ]}
                      onValueChange={(viewId) =>
                        onChange(viewId === "default" ? null : viewId)
                      }
                      disabled={disabled}
                      noCapture
                    />
                  </div>
                )}
                {selectedView && (
                  <p className="text-muted-foreground text-xs">
                    Changes to this saved view apply everywhere it is used.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    text="Create view"
                    variant="secondary"
                    disabled={disabled || !canSaveViews || !canReadViews}
                    onClick={() => {
                      createView.reset();
                      updateView.reset();
                      openDialog({ type: "create" });
                    }}
                  />
                  {selectedView && (
                    <Button
                      text="Edit view"
                      variant="ghost"
                      disabled={
                        disabled || !canSaveViews || !selectedView.canEdit
                      }
                      onClick={() => {
                        createView.reset();
                        updateView.reset();
                        openDialog({ type: "edit", view: selectedView });
                      }}
                    />
                  )}
                </div>
              </div>
            </Accordion.Content>
          </Accordion.Item>
        </Accordion>
      )}
    </DialogController>
  );
}

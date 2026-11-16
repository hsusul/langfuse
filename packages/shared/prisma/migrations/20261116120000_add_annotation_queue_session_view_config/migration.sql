ALTER TABLE "annotation_queues"
ADD COLUMN "session_view_filters" JSONB,
ADD COLUMN "session_view_mode" "SessionViewMode",
ADD COLUMN "session_view_unmatched_traces" "SessionUnmatchedTraces",
ADD CONSTRAINT "annotation_queues_session_view_config_check"
CHECK (
  num_nonnulls("session_view_filters", "session_view_mode", "session_view_unmatched_traces") IN (0, 3)
);

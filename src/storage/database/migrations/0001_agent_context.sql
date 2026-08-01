begin;

create table if not exists project_contexts (
  project_id varchar(36) primary key references projects(id) on delete cascade,
  current_stage varchar(64) not null default 'unknown',
  stage_confidence integer not null default 0 check (stage_confidence between 0 and 100),
  summary text not null default '',
  target_company varchar(255),
  investors jsonb not null default '[]'::jsonb,
  key_dates jsonb not null default '[]'::jsonb,
  source varchar(32) not null default 'derived',
  context_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_contexts_stage_idx
  on project_contexts(current_stage);

create table if not exists project_events (
  id varchar(36) primary key default gen_random_uuid(),
  project_id varchar(36) not null references projects(id) on delete cascade,
  event_type varchar(128) not null,
  stage varchar(64) not null,
  event_date date,
  title varchar(255) not null,
  status varchar(32) not null default 'confirmed',
  evidence_file_ids jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  confidence integer not null default 0 check (confidence between 0 and 100),
  requires_human_confirmation boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_events_project_date_idx
  on project_events(project_id, event_date);
create index if not exists project_events_type_idx
  on project_events(event_type);

create table if not exists document_facts (
  id varchar(36) primary key default gen_random_uuid(),
  project_id varchar(36) not null references projects(id) on delete cascade,
  archived_file_id varchar(36) references archived_files(id) on delete set null,
  source_fingerprint varchar(64) not null,
  fingerprint_kind varchar(32) not null,
  original_name varchar(512) not null,
  storage_key varchar(1024),
  file_size bigint not null default 0,
  mime_type varchar(255) not null default '',
  document_type varchar(128) not null,
  raw_document_type varchar(255) not null,
  title varchar(512) not null,
  document_number varchar(255),
  version varchar(255),
  document_dates jsonb not null default '[]'::jsonb,
  parties jsonb not null default '[]'::jsonb,
  sign_status varchar(32) not null,
  transaction_changes jsonb not null default '[]'::jsonb,
  explicit_stage_clues jsonb not null default '[]'::jsonb,
  evidence_quotes jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  source_quality varchar(32) not null,
  extraction_confidence integer not null default 0 check (extraction_confidence between 0 and 100),
  extraction_status varchar(32) not null,
  extraction_error text,
  extractor_version varchar(64) not null,
  model_version varchar(128) not null,
  facts_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, source_fingerprint)
);

create index if not exists document_facts_archived_file_idx
  on document_facts(archived_file_id);
create index if not exists document_facts_type_idx
  on document_facts(project_id, document_type);

create table if not exists classification_decisions (
  id varchar(36) primary key default gen_random_uuid(),
  project_id varchar(36) not null references projects(id) on delete cascade,
  archived_file_id varchar(36) references archived_files(id) on delete set null,
  document_fact_id varchar(36) references document_facts(id) on delete set null,
  selected_category_id varchar(128),
  selected_category_name varchar(255),
  selected_folder_path jsonb,
  candidate_categories jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  contradictions jsonb not null default '[]'::jsonb,
  decision_score integer not null default 0 check (decision_score between 0 and 100),
  decision_source varchar(32) not null,
  reasoning text not null default '',
  model_version varchar(128),
  policy_version varchar(64) not null,
  requires_review boolean not null default true,
  review_status varchar(32) not null default 'pending',
  corrected_category_id varchar(128),
  corrected_category_name varchar(255),
  corrected_folder_path jsonb,
  correction_reason text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists classification_decisions_project_idx
  on classification_decisions(project_id);
create index if not exists classification_decisions_review_idx
  on classification_decisions(project_id, review_status);
create index if not exists classification_decisions_fact_idx
  on classification_decisions(document_fact_id);

commit;

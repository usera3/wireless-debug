create table if not exists devices (
  device_id varchar(128) primary key,
  display_name varchar(128),
  note text,
  availability varchar(32) not null default 'unknown',
  net_mode varchar(32),
  ap_ip varchar(64),
  sta_ip varchar(64),
  sta_connected boolean not null default false,
  uart_baud integer,
  fw_version varchar(128),
  last_seen_at timestamptz,
  last_status_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists device_status_events (
  id uuid primary key,
  device_id varchar(128) not null references devices(device_id) on delete cascade,
  event_type varchar(32) not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists device_commands (
  id uuid primary key,
  command_id varchar(96) not null unique,
  device_id varchar(128) not null references devices(device_id) on delete cascade,
  command_type varchar(64) not null,
  args_json jsonb not null default '{}'::jsonb,
  state varchar(32) not null,
  ack_ok boolean,
  ack_message text,
  requested_by varchar(128) not null,
  created_at timestamptz not null default now(),
  ack_at timestamptz
);

create table if not exists device_notes (
  id uuid primary key,
  device_id varchar(128) not null references devices(device_id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_devices_last_seen on devices (last_seen_at desc);
create index if not exists idx_device_status_events_device_created on device_status_events (device_id, created_at desc);
create index if not exists idx_device_commands_device_created on device_commands (device_id, created_at desc);
create index if not exists idx_device_notes_device_created on device_notes (device_id, created_at desc);

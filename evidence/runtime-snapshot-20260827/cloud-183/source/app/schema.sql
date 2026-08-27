create table if not exists cloud_devices (
  device_id varchar(128) primary key,
  device_mac varchar(32),
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

alter table cloud_devices add column if not exists device_mac varchar(32);

create table if not exists cloud_device_status_events (
  id uuid primary key,
  device_id varchar(128) not null references cloud_devices(device_id) on delete cascade,
  event_type varchar(32) not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists cloud_device_commands (
  id uuid primary key,
  command_id varchar(96) not null unique,
  device_id varchar(128) not null references cloud_devices(device_id) on delete cascade,
  command_type varchar(64) not null,
  args_json jsonb not null default '{}'::jsonb,
  state varchar(32) not null,
  ack_ok boolean,
  ack_message text,
  requested_by varchar(128) not null,
  created_at timestamptz not null default now(),
  ack_at timestamptz
);

create table if not exists cloud_device_notes (
  id uuid primary key,
  device_id varchar(128) not null references cloud_devices(device_id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create table if not exists cloud_bus_messages (
  id uuid primary key,
  message_id varchar(96) not null unique,
  source_type varchar(32) not null,
  source_id varchar(128) not null,
  target_type varchar(32) not null,
  target_id varchar(128) not null,
  channel varchar(32) not null,
  payload_type varchar(32) not null default 'text',
  payload_text text not null,
  payload_json jsonb not null default '{}'::jsonb,
  state varchar(32) not null default 'PENDING',
  ack_ok boolean,
  ack_message text,
  requested_by varchar(128) not null default 'cloud',
  created_at timestamptz not null default now(),
  published_at timestamptz,
  ack_at timestamptz
);

create table if not exists cloud_message_subscriptions (
  id uuid primary key,
  subscriber_type varchar(32) not null,
  subscriber_id varchar(128) not null,
  source_type varchar(32) not null,
  source_id varchar(128) not null,
  channel varchar(32) not null,
  enabled boolean not null default true,
  route_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscriber_type, subscriber_id, source_type, source_id, channel)
);

create index if not exists idx_cloud_devices_last_seen on cloud_devices (last_seen_at desc);
create unique index if not exists idx_cloud_devices_display_name_unique
  on cloud_devices (lower(display_name))
  where display_name is not null and btrim(display_name) <> '';
create index if not exists idx_cloud_device_status_events_device_created on cloud_device_status_events (device_id, created_at desc);
create index if not exists idx_cloud_device_commands_device_created on cloud_device_commands (device_id, created_at desc);
create index if not exists idx_cloud_device_notes_device_created on cloud_device_notes (device_id, created_at desc);
create index if not exists idx_cloud_bus_messages_created on cloud_bus_messages (created_at desc);
create index if not exists idx_cloud_bus_messages_target_created on cloud_bus_messages (target_type, target_id, created_at desc);
create index if not exists idx_cloud_message_subscriptions_subscriber
  on cloud_message_subscriptions (subscriber_type, subscriber_id, enabled);

create table user_accounts (
  id uuid primary key,
  email varchar(255) not null unique,
  password_hash varchar(255) not null,
  role varchar(32) not null,
  enabled boolean not null,
  created_at timestamp not null
);

create table devices (
  device_id varchar(128) primary key,
  availability varchar(32) not null,
  status_json text,
  status_at timestamp,
  net_mode varchar(32),
  ap_ip varchar(64),
  sta_ip varchar(64),
  sta_connected boolean not null,
  uart_baud integer,
  updated_at timestamp not null
);

create table device_commands (
  id uuid primary key,
  command_id varchar(64) not null unique,
  device_id varchar(128) not null,
  requested_by_email varchar(255) not null,
  type varchar(64) not null,
  args_json text not null,
  state varchar(32) not null,
  ack_ok boolean,
  ack_message text,
  created_at timestamp not null,
  ack_at timestamp
);

create index idx_device_commands_device_created on device_commands (device_id, created_at desc);

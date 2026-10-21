-- ============================================================================
--  8-MASTER V2 — SCHÉMA SUPABASE COMPLET & CORRIGÉ
-- ============================================================================

-- 0. EXTENSIONS
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- 1. TYPES ÉNUMÉRÉS
do $$ begin create type game_mode as enum ('solo', 'multi', 'tournament'); exception when duplicate_object then null; end $$;
do $$ begin create type game_status as enum ('lobby', 'active', 'finished', 'abandoned'); exception when duplicate_object then null; end $$;
do $$ begin create type player_status as enum ('available', 'solo', 'offline', 'in_game', 'in_tournament'); exception when duplicate_object then null; end $$;
do $$ begin create type tournament_format as enum ('pools_finals', 'round_robin'); exception when duplicate_object then null; end $$;
do $$ begin create type tournament_status as enum ('draft', 'open', 'running', 'finished', 'cancelled'); exception when duplicate_object then null; end $$;

-- 2. TABLE : profiles
create table if not exists public.profiles (
    id                     uuid primary key references auth.users(id) on delete cascade,
    username               citext not null,
    username_display       text not null,
    username_changed_at    timestamptz not null default now(),
    avatar_url             text,
    bio                    text,
    whatsapp               text, -- Colonne ajoutée ici
    elo_global             integer not null default 1000 check (elo_global >= 0),
    elo_solo               integer not null default 1000 check (elo_solo >= 0),
    elo_multi              integer not null default 1000 check (elo_multi >= 0),
    elo_tournament         integer not null default 1000 check (elo_tournament >= 0),
    games_played           integer not null default 0 check (games_played >= 0),
    games_won              integer not null default 0 check (games_won >= 0),
    games_lost             integer not null default 0 check (games_lost >= 0),
    games_drawn            integer not null default 0 check (games_drawn >= 0),
    status                 player_status not null default 'available',
    last_seen_at           timestamptz not null default now(),
    is_admin               boolean not null default false,
    is_banned              boolean not null default false,
    must_change_password   boolean not null default false,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    constraint username_length check (char_length(username_display) between 3 and 16),
    constraint username_chars  check (username_display ~ '^[A-Za-z0-9_-]+$')
);

-- Sécurité : on s'assure que si la table existait déjà, on ajoute la colonne whatsapp
alter table public.profiles add column if not exists whatsapp text;

create unique index if not exists profiles_username_uniq on public.profiles(username);
create index if not exists profiles_status_idx on public.profiles(status);
create index if not exists profiles_elo_idx on public.profiles(elo_global desc);

-- 3. TABLE : username_history
create table if not exists public.username_history (
    id            bigserial primary key,
    user_id       uuid not null references public.profiles(id) on delete cascade,
    old_username  citext,
    new_username  citext not null,
    changed_at    timestamptz not null default now()
);

-- 4. TABLE : emotes
create table if not exists public.emotes (
    code          text primary key,
    label         text not null,
    is_active     boolean not null default true,
    created_at    timestamptz not null default now()
);
insert into public.emotes (code, label) values
    ('GG', 'Bien joué'), ('NICE', 'Joli coup'), ('OOPS', 'Oups'),
    ('THINK', 'Je réfléchis'), ('WOW', 'Impressionnant'), ('RESPECT', 'Respect'),
    ('GLHF', 'Bonne chance'), ('THANKS', 'Merci')
on conflict (code) do nothing;

-- 5. TABLE : games
create table if not exists public.games (
    id              uuid primary key default uuid_generate_v4(),
    mode            game_mode not null,
    status          game_status not null default 'lobby',
    host_id         uuid references public.profiles(id) on delete set null,
    join_code       text unique,
    num_decks       smallint not null default 1 check (num_decks between 1 and 3),
    cards_per_player smallint not null default 6 check (cards_per_player between 3 and 8),
    player_count    smallint not null default 2 check (player_count between 2 and 15),
    state_json      jsonb not null default '{}'::jsonb,
    seq             bigint not null default 0,
    winner_id       uuid references public.profiles(id) on delete set null,
    duration_seconds integer,
    turns_count     integer,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- 6. TABLE : game_players
create table if not exists public.game_players (
    id              bigserial primary key,
    game_id         uuid not null references public.games(id) on delete cascade,
    user_id         uuid references public.profiles(id) on delete set null,
    bot_id          text,
    display_name    text not null,
    seat            smallint not null,
    is_human        boolean not null default true,
    final_score     integer,
    is_winner       boolean not null default false,
    is_eliminated   boolean not null default false,
    last_hand_points integer,
    last_hand_count  integer,
    joined_at       timestamptz not null default now(),
    left_at         timestamptz,
    unique (game_id, seat)
);

-- 7. TABLE : game_rounds
create table if not exists public.game_rounds (
    id              bigserial primary key,
    game_id         uuid not null references public.games(id) on delete cascade,
    round_number    smallint not null,
    dealer_id       uuid references public.profiles(id) on delete set null,
    starting_card   jsonb,
    winner_id       uuid references public.profiles(id) on delete set null,
    last_card       jsonb,
    summary_json    jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now(),
    unique (game_id, round_number)
);

-- 8. TABLE : game_events
create table if not exists public.game_events (
    id              bigserial primary key,
    game_id         uuid not null references public.games(id) on delete cascade,
    seq             bigint not null,
    round_number    smallint,
    event_type      text not null,
    actor_id        uuid references public.profiles(id) on delete set null,
    payload         jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now(),
    unique (game_id, seq)
);

-- 9. TABLES : tournaments
create table if not exists public.tournaments (
    id              uuid primary key default uuid_generate_v4(),
    name            text not null,
    format          tournament_format not null,
    status          tournament_status not null default 'draft',
    admin_id        uuid not null references public.profiles(id) on delete restrict,
    max_players     smallint not null default 16 check (max_players between 2 and 64),
    starts_at       timestamptz,
    finished_at     timestamptz,
    config_json     jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create table if not exists public.tournament_participants (
    id              bigserial primary key,
    tournament_id   uuid not null references public.tournaments(id) on delete cascade,
    user_id         uuid not null references public.profiles(id) on delete cascade,
    pool_letter     text,
    points          integer not null default 0,
    is_eliminated   boolean not null default false,
    is_repêché      boolean not null default false,
    registered_at   timestamptz not null default now(),
    unique (tournament_id, user_id)
);

-- 10. TABLE : invitations
create table if not exists public.invitations (
    id              bigserial primary key,
    game_id         uuid not null references public.games(id) on delete cascade,
    inviter_id      uuid not null references public.profiles(id) on delete cascade,
    invitee_id      uuid not null references public.profiles(id) on delete cascade,
    accepted        boolean,
    expires_at      timestamptz not null default (now() + interval '60 seconds'),
    created_at      timestamptz not null default now()
);

-- ============================================================================
-- 11. FONCTIONS & TRIGGERS (C'est ici que se joue la correction de ton erreur)
-- ============================================================================

-- Trigger pour la date de mise à jour
create or replace function public.fn_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles for each row execute function public.fn_touch_updated_at();

drop trigger if exists trg_games_touch on public.games;
create trigger trg_games_touch before update on public.games for each row execute function public.fn_touch_updated_at();

-- ✅ TRIGGER CRUCIAL : CRÉATION AUTOMATIQUE DU PROFIL À L'INSCRIPTION
-- On supprime l'ancien trigger s'il existe
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- On recrée une fonction propre et robuste
create or replace function public.fn_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    base_username text;
    final_username text;
    counter int := 0;
    v_whatsapp text;
begin
    -- 1. On récupère le pseudo envoyé par le jeu
    base_username := coalesce(new.raw_user_meta_data->>'username', 'player_' || substr(new.id::text, 1, 8));
    
    -- 2. On nettoie le pseudo (pas de caractères spéciaux)
    base_username := regexp_replace(base_username, '[^A-Za-z0-9_-]', '', 'g');
    
    -- 3. On vérifie la taille
    if char_length(base_username) < 3 then base_username := 'player_' || substr(new.id::text, 1, 8); end if;
    if char_length(base_username) > 16 then base_username := substr(base_username, 1, 16); end if;
    
    -- 4. On récupère le numéro WhatsApp
    v_whatsapp := new.raw_user_meta_data->>'whatsapp';
    final_username := base_username;
    
    -- 5. On gère les doublons de pseudo (ex: si "Berlecka" existe déjà, ça mettra "Berlecka_1")
    while exists (select 1 from public.profiles where username = final_username) loop
        counter := counter + 1;
        final_username := substr(base_username, 1, 13) || '_' || counter::text;
        if counter > 100 then final_username := 'player_' || substr(new.id::text, 1, 8); exit; end if;
    end loop;

    -- 6. On insère dans la table profiles
    insert into public.profiles (id, username, username_display, whatsapp) 
    values (new.id, final_username, final_username, v_whatsapp) 
    on conflict (id) do nothing;

    return new;
end $$;

-- On attache la fonction au trigger d'inscription
create trigger on_auth_user_created 
after insert on auth.users 
for each row execute function public.fn_handle_new_user();

-- Trigger pour empêcher le changement de pseudo trop fréquent
create or replace function public.fn_check_username_change()
returns trigger language plpgsql as $$
begin
    if new.username is distinct from old.username then
        if (now() - old.username_changed_at) < interval '30 days' then
            raise exception 'Changement de pseudo refusé : 1 seul changement autorisé tous les 30 jours.' using errcode = 'P0001';
        end if;
        new.username_changed_at := now();
        insert into public.username_history(user_id, old_username, new_username) values (old.id, old.username, new.username);
    end if;
    return new;
end $$;

drop trigger if exists trg_profiles_username_change on public.profiles;
create trigger trg_profiles_username_change before update of username on public.profiles for each row execute function public.fn_check_username_change();


-- ============================================================================
-- 12. RLS (Row Level Security) - Sécurité des données
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.username_history enable row level security;
alter table public.emotes enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.game_rounds enable row level security;
alter table public.game_events enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_participants enable row level security;
alter table public.invitations enable row level security;

-- Nettoyage des anciennes politiques pour éviter les conflits
drop policy if exists "profiles_select_public" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;

-- Création des politiques
create policy "profiles_select_public" on public.profiles for select using (true);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);

-- GAMES Policies
drop policy if exists "games_select_participant" on public.games;
create policy "games_select_participant" on public.games for select using (
    exists (select 1 from public.game_players gp where gp.game_id = games.id and gp.user_id = auth.uid()) 
    or host_id = auth.uid() or status = 'finished'
);
drop policy if exists "games_insert_auth" on public.games;
create policy "games_insert_auth" on public.games for insert with check (auth.uid() = host_id);
drop policy if exists "games_update_host" on public.games;
create policy "games_update_host" on public.games for update using (auth.uid() = host_id or exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));

-- GAME PLAYERS Policies
drop policy if exists "game_players_select" on public.game_players;
create policy "game_players_select" on public.game_players for select using (
    user_id = auth.uid() or exists (select 1 from public.game_players gp where gp.game_id = game_players.game_id and gp.user_id = auth.uid())
);
drop policy if exists "game_players_insert_self" on public.game_players;
create policy "game_players_insert_self" on public.game_players for insert with check (user_id = auth.uid() or user_id is null);

-- EMOTES Policies
drop policy if exists "emotes_select_all" on public.emotes;
create policy "emotes_select_all" on public.emotes for select using (is_active = true);

-- TOURNAMENTS Policies
drop policy if exists "tournaments_select" on public.tournaments;
create policy "tournaments_select" on public.tournaments for select using (true);
drop policy if exists "tournaments_admin_write" on public.tournaments;
create policy "tournaments_admin_write" on public.tournaments for all using (exists (select 1 from public.profiles where id = auth.uid() and is_admin = true));
drop policy if exists "tp_select" on public.tournament_participants;
create policy "tp_select" on public.tournament_participants for select using (true);

-- ============================================================================
-- 13. VUES UTILITAIRES
-- ============================================================================
create or replace view public.v_leaderboard as
select p.id, p.username_display as username, p.elo_global, p.elo_solo, p.games_played, p.games_won,
case when p.games_played > 0 then round(100.0 * p.games_won / p.games_played, 1) else 0 end as win_rate,
rank() over (order by p.elo_global desc) as rank
from public.profiles p where p.is_banned = false;
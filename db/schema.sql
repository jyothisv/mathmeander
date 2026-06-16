\restrict dbmate

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aliases (
    id uuid NOT NULL,
    object_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    scope text NOT NULL,
    scope_ref uuid
);


--
-- Name: content_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_units (
    id uuid NOT NULL,
    object_id uuid NOT NULL,
    parent_unit_id uuid,
    "position" integer NOT NULL,
    slot text,
    type text,
    example_kind text,
    status text NOT NULL,
    declared_by text NOT NULL,
    extracted_structure jsonb,
    content jsonb NOT NULL,
    content_kind text GENERATED ALWAYS AS ((content ->> 'kind'::text)) STORED,
    provenance_id uuid NOT NULL
);


--
-- Name: definition_detail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.definition_detail (
    object_id uuid NOT NULL,
    term text NOT NULL
);


--
-- Name: handles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.handles (
    id uuid NOT NULL,
    space_id uuid NOT NULL,
    name text NOT NULL,
    target_object_id uuid NOT NULL,
    target_unit_id uuid,
    target_expression_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    scope text NOT NULL,
    provenance_id uuid NOT NULL,
    CONSTRAINT handles_exactly_one_refinement CHECK (((((target_unit_id IS NOT NULL))::integer + ((target_expression_id IS NOT NULL))::integer) = 1))
);


--
-- Name: links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.links (
    id uuid NOT NULL,
    source_object_id uuid NOT NULL,
    target_object_id uuid,
    target_unit_id uuid,
    unresolved_text text,
    target_selector jsonb,
    type text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    from_content boolean NOT NULL,
    source_unit_id uuid,
    content_locator jsonb,
    in_expression boolean GENERATED ALWAYS AS (((content_locator ->> 'kind'::text) = 'expression_span'::text)) STORED,
    provenance_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT links_deliberate_needs_object CHECK ((from_content OR (target_object_id IS NOT NULL))),
    CONSTRAINT links_exactly_one_target CHECK (((((target_object_id IS NOT NULL))::integer + ((unresolved_text IS NOT NULL))::integer) = 1)),
    CONSTRAINT links_unit_needs_object CHECK (((target_unit_id IS NULL) OR (target_object_id IS NOT NULL)))
);


--
-- Name: object_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.object_versions (
    id uuid NOT NULL,
    object_id uuid NOT NULL,
    version_no integer NOT NULL,
    snapshot jsonb NOT NULL,
    provenance_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.objects (
    id uuid NOT NULL,
    type text NOT NULL,
    title text,
    raw_source text,
    status text NOT NULL,
    schema_version integer NOT NULL,
    revision integer NOT NULL,
    provenance_id uuid NOT NULL,
    space_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: provenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance (
    id uuid NOT NULL,
    origin text NOT NULL,
    created_by text,
    occurred_at timestamp with time zone NOT NULL
);


--
-- Name: provenance_derivations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provenance_derivations (
    provenance_id uuid NOT NULL,
    derived_from_provenance_id uuid NOT NULL,
    CONSTRAINT provenance_derivations_no_self CHECK ((provenance_id <> derived_from_provenance_id))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spaces (
    id uuid NOT NULL,
    owner_user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: taggings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.taggings (
    id uuid NOT NULL,
    tag_id uuid NOT NULL,
    tagged_object_id uuid,
    tagged_unit_id uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT taggings_exactly_one_target CHECK (((((tagged_object_id IS NOT NULL))::integer + ((tagged_unit_id IS NOT NULL))::integer) = 1))
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid NOT NULL,
    space_id uuid NOT NULL,
    name text NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    idp_issuer text NOT NULL,
    idp_subject text NOT NULL,
    email text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: aliases aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_pkey PRIMARY KEY (id);


--
-- Name: content_units content_units_id_object_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_units
    ADD CONSTRAINT content_units_id_object_id_key UNIQUE (id, object_id);


--
-- Name: content_units content_units_object_id_parent_unit_id_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_units
    ADD CONSTRAINT content_units_object_id_parent_unit_id_position_key UNIQUE NULLS NOT DISTINCT (object_id, parent_unit_id, "position");


--
-- Name: content_units content_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_units
    ADD CONSTRAINT content_units_pkey PRIMARY KEY (id);


--
-- Name: definition_detail definition_detail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.definition_detail
    ADD CONSTRAINT definition_detail_pkey PRIMARY KEY (object_id);


--
-- Name: handles handles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handles
    ADD CONSTRAINT handles_pkey PRIMARY KEY (id);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);


--
-- Name: object_versions object_versions_object_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_versions
    ADD CONSTRAINT object_versions_object_id_version_no_key UNIQUE (object_id, version_no);


--
-- Name: object_versions object_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_versions
    ADD CONSTRAINT object_versions_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: provenance_derivations provenance_derivations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_derivations
    ADD CONSTRAINT provenance_derivations_pkey PRIMARY KEY (provenance_id, derived_from_provenance_id);


--
-- Name: provenance provenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: spaces spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);


--
-- Name: taggings taggings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_space_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_space_id_name_key UNIQUE (space_id, name);


--
-- Name: users users_idp_issuer_idp_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_idp_issuer_idp_subject_key UNIQUE (idp_issuer, idp_subject);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: aliases_by_object; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX aliases_by_object ON public.aliases USING btree (object_id);


--
-- Name: links_backlinks; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX links_backlinks ON public.links USING btree (target_object_id) WHERE (target_object_id IS NOT NULL);


--
-- Name: links_by_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX links_by_source ON public.links USING btree (source_object_id);


--
-- Name: objects_by_space_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX objects_by_space_created ON public.objects USING btree (space_id, created_at DESC);


--
-- Name: sessions_active_by_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_active_by_user ON public.sessions USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: taggings_unique_object; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX taggings_unique_object ON public.taggings USING btree (tag_id, tagged_object_id) WHERE (tagged_object_id IS NOT NULL);


--
-- Name: taggings_unique_unit; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX taggings_unique_unit ON public.taggings USING btree (tag_id, tagged_unit_id) WHERE (tagged_unit_id IS NOT NULL);


--
-- Name: aliases aliases_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id);


--
-- Name: content_units content_units_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_units
    ADD CONSTRAINT content_units_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id);


--
-- Name: content_units content_units_parent_unit_id_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_units
    ADD CONSTRAINT content_units_parent_unit_id_object_id_fkey FOREIGN KEY (parent_unit_id, object_id) REFERENCES public.content_units(id, object_id);


--
-- Name: content_units content_units_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_units
    ADD CONSTRAINT content_units_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES public.provenance(id);


--
-- Name: definition_detail definition_detail_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.definition_detail
    ADD CONSTRAINT definition_detail_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id);


--
-- Name: handles handles_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handles
    ADD CONSTRAINT handles_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES public.provenance(id);


--
-- Name: handles handles_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handles
    ADD CONSTRAINT handles_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: handles handles_target_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handles
    ADD CONSTRAINT handles_target_object_id_fkey FOREIGN KEY (target_object_id) REFERENCES public.objects(id);


--
-- Name: handles handles_target_unit_id_target_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.handles
    ADD CONSTRAINT handles_target_unit_id_target_object_id_fkey FOREIGN KEY (target_unit_id, target_object_id) REFERENCES public.content_units(id, object_id);


--
-- Name: links links_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES public.provenance(id);


--
-- Name: links links_source_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_source_object_id_fkey FOREIGN KEY (source_object_id) REFERENCES public.objects(id);


--
-- Name: links links_source_unit_id_source_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_source_unit_id_source_object_id_fkey FOREIGN KEY (source_unit_id, source_object_id) REFERENCES public.content_units(id, object_id);


--
-- Name: links links_target_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_target_object_id_fkey FOREIGN KEY (target_object_id) REFERENCES public.objects(id);


--
-- Name: links links_target_unit_id_target_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_target_unit_id_target_object_id_fkey FOREIGN KEY (target_unit_id, target_object_id) REFERENCES public.content_units(id, object_id);


--
-- Name: object_versions object_versions_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_versions
    ADD CONSTRAINT object_versions_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.objects(id);


--
-- Name: object_versions object_versions_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.object_versions
    ADD CONSTRAINT object_versions_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES public.provenance(id);


--
-- Name: objects objects_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES public.provenance(id);


--
-- Name: objects objects_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.objects
    ADD CONSTRAINT objects_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: provenance_derivations provenance_derivations_derived_from_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_derivations
    ADD CONSTRAINT provenance_derivations_derived_from_provenance_id_fkey FOREIGN KEY (derived_from_provenance_id) REFERENCES public.provenance(id);


--
-- Name: provenance_derivations provenance_derivations_provenance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provenance_derivations
    ADD CONSTRAINT provenance_derivations_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES public.provenance(id);


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: spaces spaces_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id);


--
-- Name: taggings taggings_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id);


--
-- Name: taggings taggings_tagged_object_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_tagged_object_id_fkey FOREIGN KEY (tagged_object_id) REFERENCES public.objects(id);


--
-- Name: taggings taggings_tagged_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_tagged_unit_id_fkey FOREIGN KEY (tagged_unit_id) REFERENCES public.content_units(id);


--
-- Name: tags tags_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('0001'),
    ('0002');

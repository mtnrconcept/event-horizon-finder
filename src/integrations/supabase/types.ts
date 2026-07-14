export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          metadata: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json | null
        }
        Relationships: []
      }
      calendar_items: {
        Row: {
          created_at: string
          event_id: string
          id: string
          notes: string | null
          occurrence_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          notes?: string | null
          occurrence_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          notes?: string | null
          occurrence_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_items_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_items_occurrence_id_fkey"
            columns: ["occurrence_id"]
            isOneToOne: false
            referencedRelation: "event_occurrences"
            referencedColumns: ["id"]
          },
        ]
      }
      cities: {
        Row: {
          country_id: string
          created_at: string
          id: string
          is_demo: boolean
          latitude: number | null
          location: unknown
          longitude: number | null
          name: string
          region_id: string | null
          slug: string
          timezone: string
        }
        Insert: {
          country_id: string
          created_at?: string
          id?: string
          is_demo?: boolean
          latitude?: number | null
          location?: unknown
          longitude?: number | null
          name: string
          region_id?: string | null
          slug: string
          timezone?: string
        }
        Update: {
          country_id?: string
          created_at?: string
          id?: string
          is_demo?: boolean
          latitude?: number | null
          location?: unknown
          longitude?: number | null
          name?: string
          region_id?: string | null
          slug?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "cities_country_id_fkey"
            columns: ["country_id"]
            isOneToOne: false
            referencedRelation: "countries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cities_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      countries: {
        Row: {
          code: string
          id: string
          name: string
        }
        Insert: {
          code: string
          id?: string
          name: string
        }
        Update: {
          code?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      data_sources: {
        Row: {
          base_url: string
          created_at: string
          domain: string
          id: string
          is_authorized: boolean
          is_verified: boolean
          last_sync_at: string | null
          legal_basis: string | null
          name: string
          next_sync_at: string | null
          organizer_id: string | null
          source_type: Database["public"]["Enums"]["data_source_type"]
          status: string | null
          sync_frequency: string | null
          venue_id: string | null
        }
        Insert: {
          base_url: string
          created_at?: string
          domain: string
          id?: string
          is_authorized?: boolean
          is_verified?: boolean
          last_sync_at?: string | null
          legal_basis?: string | null
          name: string
          next_sync_at?: string | null
          organizer_id?: string | null
          source_type?: Database["public"]["Enums"]["data_source_type"]
          status?: string | null
          sync_frequency?: string | null
          venue_id?: string | null
        }
        Update: {
          base_url?: string
          created_at?: string
          domain?: string
          id?: string
          is_authorized?: boolean
          is_verified?: boolean
          last_sync_at?: string | null
          legal_basis?: string | null
          name?: string
          next_sync_at?: string | null
          organizer_id?: string | null
          source_type?: Database["public"]["Enums"]["data_source_type"]
          status?: string | null
          sync_frequency?: string | null
          venue_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "data_sources_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "organizers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "data_sources_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      event_accessibility: {
        Row: {
          event_id: string
          hearing_loop: boolean | null
          notes: string | null
          quiet_space: boolean | null
          sign_language: boolean | null
          wheelchair: boolean | null
        }
        Insert: {
          event_id: string
          hearing_loop?: boolean | null
          notes?: string | null
          quiet_space?: boolean | null
          sign_language?: boolean | null
          wheelchair?: boolean | null
        }
        Update: {
          event_id?: string
          hearing_loop?: boolean | null
          notes?: string | null
          quiet_space?: boolean | null
          sign_language?: boolean | null
          wheelchair?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "event_accessibility_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: true
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_categories: {
        Row: {
          icon: string | null
          id: string
          name_en: string
          name_fr: string
          slug: string
          sort_order: number
        }
        Insert: {
          icon?: string | null
          id?: string
          name_en: string
          name_fr: string
          slug: string
          sort_order?: number
        }
        Update: {
          icon?: string | null
          id?: string
          name_en?: string
          name_fr?: string
          slug?: string
          sort_order?: number
        }
        Relationships: []
      }
      event_media: {
        Row: {
          attribution: string | null
          event_id: string
          id: string
          license: string | null
          media_type: string
          sort_order: number | null
          source_url: string | null
          url: string
        }
        Insert: {
          attribution?: string | null
          event_id: string
          id?: string
          license?: string | null
          media_type?: string
          sort_order?: number | null
          source_url?: string | null
          url: string
        }
        Update: {
          attribution?: string | null
          event_id?: string
          id?: string
          license?: string | null
          media_type?: string
          sort_order?: number | null
          source_url?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_media_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_occurrences: {
        Row: {
          capacity: number | null
          created_at: string
          doors_open_at: string | null
          ends_at: string | null
          event_id: string
          id: string
          latitude: number | null
          local_end_date: string | null
          local_start_date: string | null
          location: unknown
          longitude: number | null
          starts_at: string
          status: Database["public"]["Enums"]["occurrence_status"]
          ticket_status: Database["public"]["Enums"]["ticket_status"]
          timezone: string
          updated_at: string
        }
        Insert: {
          capacity?: number | null
          created_at?: string
          doors_open_at?: string | null
          ends_at?: string | null
          event_id: string
          id?: string
          latitude?: number | null
          local_end_date?: string | null
          local_start_date?: string | null
          location?: unknown
          longitude?: number | null
          starts_at: string
          status?: Database["public"]["Enums"]["occurrence_status"]
          ticket_status?: Database["public"]["Enums"]["ticket_status"]
          timezone?: string
          updated_at?: string
        }
        Update: {
          capacity?: number | null
          created_at?: string
          doors_open_at?: string | null
          ends_at?: string | null
          event_id?: string
          id?: string
          latitude?: number | null
          local_end_date?: string | null
          local_start_date?: string | null
          location?: unknown
          longitude?: number | null
          starts_at?: string
          status?: Database["public"]["Enums"]["occurrence_status"]
          ticket_status?: Database["public"]["Enums"]["ticket_status"]
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_occurrences_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_performers: {
        Row: {
          event_id: string
          is_headliner: boolean | null
          performer_id: string
        }
        Insert: {
          event_id: string
          is_headliner?: boolean | null
          performer_id: string
        }
        Update: {
          event_id?: string
          is_headliner?: boolean | null
          performer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_performers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_performers_performer_id_fkey"
            columns: ["performer_id"]
            isOneToOne: false
            referencedRelation: "performers"
            referencedColumns: ["id"]
          },
        ]
      }
      event_reports: {
        Row: {
          created_at: string
          details: string | null
          event_id: string
          id: string
          reason: string
          reported_by: string | null
          status: string | null
        }
        Insert: {
          created_at?: string
          details?: string | null
          event_id: string
          id?: string
          reason: string
          reported_by?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string
          details?: string | null
          event_id?: string
          id?: string
          reason?: string
          reported_by?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_reports_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_status_history: {
        Row: {
          changed_by: string | null
          created_at: string
          event_id: string
          id: string
          new_status: Database["public"]["Enums"]["event_status"]
          notes: string | null
          previous_status: Database["public"]["Enums"]["event_status"] | null
        }
        Insert: {
          changed_by?: string | null
          created_at?: string
          event_id: string
          id?: string
          new_status: Database["public"]["Enums"]["event_status"]
          notes?: string | null
          previous_status?: Database["public"]["Enums"]["event_status"] | null
        }
        Update: {
          changed_by?: string | null
          created_at?: string
          event_id?: string
          id?: string
          new_status?: Database["public"]["Enums"]["event_status"]
          notes?: string | null
          previous_status?: Database["public"]["Enums"]["event_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "event_status_history_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          age_restriction: string | null
          category_id: string | null
          cover_image_url: string | null
          created_at: string
          created_by: string | null
          description: string | null
          genres: string[] | null
          id: string
          is_demo: boolean
          is_free: boolean
          is_verified: boolean
          language: string | null
          official_url: string | null
          organizer_id: string | null
          publication_status: string
          published_at: string | null
          search_tsv: unknown
          short_description: string | null
          slug: string
          source_confidence: number | null
          status: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at: string
          venue_id: string | null
          verification_level: Database["public"]["Enums"]["verification_level"]
        }
        Insert: {
          age_restriction?: string | null
          category_id?: string | null
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          genres?: string[] | null
          id?: string
          is_demo?: boolean
          is_free?: boolean
          is_verified?: boolean
          language?: string | null
          official_url?: string | null
          organizer_id?: string | null
          publication_status?: string
          published_at?: string | null
          search_tsv?: unknown
          short_description?: string | null
          slug: string
          source_confidence?: number | null
          status?: Database["public"]["Enums"]["event_status"]
          title: string
          updated_at?: string
          venue_id?: string | null
          verification_level?: Database["public"]["Enums"]["verification_level"]
        }
        Update: {
          age_restriction?: string | null
          category_id?: string | null
          cover_image_url?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          genres?: string[] | null
          id?: string
          is_demo?: boolean
          is_free?: boolean
          is_verified?: boolean
          language?: string | null
          official_url?: string | null
          organizer_id?: string | null
          publication_status?: string
          published_at?: string | null
          search_tsv?: unknown
          short_description?: string | null
          slug?: string
          source_confidence?: number | null
          status?: Database["public"]["Enums"]["event_status"]
          title?: string
          updated_at?: string
          venue_id?: string | null
          verification_level?: Database["public"]["Enums"]["verification_level"]
        }
        Relationships: [
          {
            foreignKeyName: "events_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "event_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "organizers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      favorites: {
        Row: {
          created_at: string
          event_id: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "favorites_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      followed_organizers: {
        Row: {
          created_at: string
          organizer_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          organizer_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          organizer_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "followed_organizers_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "organizers"
            referencedColumns: ["id"]
          },
        ]
      }
      followed_performers: {
        Row: {
          created_at: string
          performer_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          performer_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          performer_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "followed_performers_performer_id_fkey"
            columns: ["performer_id"]
            isOneToOne: false
            referencedRelation: "performers"
            referencedColumns: ["id"]
          },
        ]
      }
      followed_venues: {
        Row: {
          created_at: string
          user_id: string
          venue_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
          venue_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "followed_venues_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      ingestion_job_items: {
        Row: {
          error_message: string | null
          id: string
          ingestion_job_id: string
          processed_at: string | null
          status: string | null
          url: string
        }
        Insert: {
          error_message?: string | null
          id?: string
          ingestion_job_id: string
          processed_at?: string | null
          status?: string | null
          url: string
        }
        Update: {
          error_message?: string | null
          id?: string
          ingestion_job_id?: string
          processed_at?: string | null
          status?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_job_items_ingestion_job_id_fkey"
            columns: ["ingestion_job_id"]
            isOneToOne: false
            referencedRelation: "ingestion_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      ingestion_jobs: {
        Row: {
          created_at: string
          credits_used: number | null
          data_source_id: string | null
          duplicates_found: number | null
          error_message: string | null
          events_created: number | null
          events_updated: number | null
          finished_at: string | null
          firecrawl_id: string | null
          id: string
          metadata: Json | null
          pages_failed: number | null
          pages_found: number | null
          pages_success: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["ingestion_status"]
        }
        Insert: {
          created_at?: string
          credits_used?: number | null
          data_source_id?: string | null
          duplicates_found?: number | null
          error_message?: string | null
          events_created?: number | null
          events_updated?: number | null
          finished_at?: string | null
          firecrawl_id?: string | null
          id?: string
          metadata?: Json | null
          pages_failed?: number | null
          pages_found?: number | null
          pages_success?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["ingestion_status"]
        }
        Update: {
          created_at?: string
          credits_used?: number | null
          data_source_id?: string | null
          duplicates_found?: number | null
          error_message?: string | null
          events_created?: number | null
          events_updated?: number | null
          finished_at?: string | null
          firecrawl_id?: string | null
          id?: string
          metadata?: Json | null
          pages_failed?: number | null
          pages_found?: number | null
          pages_success?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["ingestion_status"]
        }
        Relationships: [
          {
            foreignKeyName: "ingestion_jobs_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      merge_candidates: {
        Row: {
          created_at: string
          event_a: string
          event_b: string
          id: string
          reviewed_by: string | null
          score: number
          status: string | null
        }
        Insert: {
          created_at?: string
          event_a: string
          event_b: string
          id?: string
          reviewed_by?: string | null
          score: number
          status?: string | null
        }
        Update: {
          created_at?: string
          event_a?: string
          event_b?: string
          id?: string
          reviewed_by?: string | null
          score?: number
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merge_candidates_event_a_fkey"
            columns: ["event_a"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merge_candidates_event_b_fkey"
            columns: ["event_b"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      moderation_cases: {
        Row: {
          assigned_to: string | null
          created_at: string
          id: string
          notes: string | null
          status: string | null
          subject_id: string
          subject_type: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          status?: string | null
          subject_id: string
          subject_type: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          status?: string | null
          subject_id?: string
          subject_type?: string
        }
        Relationships: []
      }
      organizer_members: {
        Row: {
          created_at: string
          id: string
          organizer_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organizer_id: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organizer_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizer_members_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "organizers"
            referencedColumns: ["id"]
          },
        ]
      }
      organizer_verifications: {
        Row: {
          created_at: string
          id: string
          notes: string | null
          organizer_id: string
          reviewed_by: string | null
          status: string
          submitted_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          notes?: string | null
          organizer_id: string
          reviewed_by?: string | null
          status?: string
          submitted_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          notes?: string | null
          organizer_id?: string
          reviewed_by?: string | null
          status?: string
          submitted_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "organizer_verifications_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "organizers"
            referencedColumns: ["id"]
          },
        ]
      }
      organizers: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_demo: boolean
          is_verified: boolean
          logo_url: string | null
          name: string
          slug: string
          updated_at: string
          verification_level: Database["public"]["Enums"]["verification_level"]
          website: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_demo?: boolean
          is_verified?: boolean
          logo_url?: string | null
          name: string
          slug: string
          updated_at?: string
          verification_level?: Database["public"]["Enums"]["verification_level"]
          website?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_demo?: boolean
          is_verified?: boolean
          logo_url?: string | null
          name?: string
          slug?: string
          updated_at?: string
          verification_level?: Database["public"]["Enums"]["verification_level"]
          website?: string | null
        }
        Relationships: []
      }
      performers: {
        Row: {
          bio: string | null
          created_at: string
          id: string
          image_url: string | null
          is_demo: boolean
          name: string
          slug: string
          type: string | null
        }
        Insert: {
          bio?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          is_demo?: boolean
          name: string
          slug: string
          type?: string | null
        }
        Update: {
          bio?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          is_demo?: boolean
          name?: string
          slug?: string
          type?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          home_city_id: string | null
          id: string
          locale: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          home_city_id?: string | null
          id: string
          locale?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          home_city_id?: string | null
          id?: string
          locale?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      regions: {
        Row: {
          country_id: string
          id: string
          name: string
        }
        Insert: {
          country_id: string
          id?: string
          name: string
        }
        Update: {
          country_id?: string
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "regions_country_id_fkey"
            columns: ["country_id"]
            isOneToOne: false
            referencedRelation: "countries"
            referencedColumns: ["id"]
          },
        ]
      }
      social_comments: {
        Row: {
          author_avatar_url: string | null
          author_display_name: string
          body: string
          created_at: string
          id: string
          post_id: string
          status: Database["public"]["Enums"]["social_comment_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          author_avatar_url?: string | null
          author_display_name?: string
          body: string
          created_at?: string
          id?: string
          post_id: string
          status?: Database["public"]["Enums"]["social_comment_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          author_avatar_url?: string | null
          author_display_name?: string
          body?: string
          created_at?: string
          id?: string
          post_id?: string
          status?: Database["public"]["Enums"]["social_comment_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      social_post_likes: {
        Row: {
          created_at: string
          post_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          post_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          post_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_post_likes_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      social_post_media: {
        Row: {
          alt_text: string | null
          created_at: string
          duration_ms: number | null
          height: number | null
          id: string
          kind: Database["public"]["Enums"]["social_media_kind"]
          mime_type: string
          post_id: string
          sort_order: number
          storage_path: string
          width: number | null
        }
        Insert: {
          alt_text?: string | null
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          kind: Database["public"]["Enums"]["social_media_kind"]
          mime_type: string
          post_id: string
          sort_order?: number
          storage_path: string
          width?: number | null
        }
        Update: {
          alt_text?: string | null
          created_at?: string
          duration_ms?: number | null
          height?: number | null
          id?: string
          kind?: Database["public"]["Enums"]["social_media_kind"]
          mime_type?: string
          post_id?: string
          sort_order?: number
          storage_path?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "social_post_media_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id"]
          },
        ]
      }
      social_posts: {
        Row: {
          body: string | null
          comment_count: number
          comments_enabled: boolean
          created_at: string
          created_by: string | null
          event_id: string | null
          id: string
          like_count: number
          organizer_id: string
          published_at: string | null
          status: Database["public"]["Enums"]["social_post_status"]
          updated_at: string
        }
        Insert: {
          body?: string | null
          comment_count?: number
          comments_enabled?: boolean
          created_at?: string
          created_by?: string | null
          event_id?: string | null
          id?: string
          like_count?: number
          organizer_id: string
          published_at?: string | null
          status?: Database["public"]["Enums"]["social_post_status"]
          updated_at?: string
        }
        Update: {
          body?: string | null
          comment_count?: number
          comments_enabled?: boolean
          created_at?: string
          created_by?: string | null
          event_id?: string | null
          id?: string
          like_count?: number
          organizer_id?: string
          published_at?: string | null
          status?: Database["public"]["Enums"]["social_post_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "social_posts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_organizer_id_fkey"
            columns: ["organizer_id"]
            isOneToOne: false
            referencedRelation: "organizers"
            referencedColumns: ["id"]
          },
        ]
      }
      source_domains: {
        Row: {
          authorized_at: string | null
          authorized_by: string | null
          created_at: string
          domain: string
          id: string
          is_authorized: boolean
          notes: string | null
        }
        Insert: {
          authorized_at?: string | null
          authorized_by?: string | null
          created_at?: string
          domain: string
          id?: string
          is_authorized?: boolean
          notes?: string | null
        }
        Update: {
          authorized_at?: string | null
          authorized_by?: string | null
          created_at?: string
          domain?: string
          id?: string
          is_authorized?: boolean
          notes?: string | null
        }
        Relationships: []
      }
      source_records: {
        Row: {
          content_hash: string | null
          data_source_id: string | null
          error_message: string | null
          external_identifier: string | null
          extracted_data: Json | null
          fetched_at: string
          id: string
          ingestion_job_id: string | null
          processed_at: string | null
          processing_status: string | null
          raw_json: Json | null
          raw_markdown: string | null
          source_url: string
          webhook_id: string | null
        }
        Insert: {
          content_hash?: string | null
          data_source_id?: string | null
          error_message?: string | null
          external_identifier?: string | null
          extracted_data?: Json | null
          fetched_at?: string
          id?: string
          ingestion_job_id?: string | null
          processed_at?: string | null
          processing_status?: string | null
          raw_json?: Json | null
          raw_markdown?: string | null
          source_url: string
          webhook_id?: string | null
        }
        Update: {
          content_hash?: string | null
          data_source_id?: string | null
          error_message?: string | null
          external_identifier?: string | null
          extracted_data?: Json | null
          fetched_at?: string
          id?: string
          ingestion_job_id?: string | null
          processed_at?: string | null
          processing_status?: string | null
          raw_json?: Json | null
          raw_markdown?: string | null
          source_url?: string
          webhook_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "source_records_data_source_id_fkey"
            columns: ["data_source_id"]
            isOneToOne: false
            referencedRelation: "data_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "source_records_ingestion_job_id_fkey"
            columns: ["ingestion_job_id"]
            isOneToOne: false
            referencedRelation: "ingestion_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      ticket_offers: {
        Row: {
          currency: string | null
          event_id: string
          id: string
          is_free: boolean | null
          name: string
          price_max: number | null
          price_min: number | null
          status: Database["public"]["Enums"]["ticket_status"] | null
          ticket_url: string | null
        }
        Insert: {
          currency?: string | null
          event_id: string
          id?: string
          is_free?: boolean | null
          name: string
          price_max?: number | null
          price_min?: number | null
          status?: Database["public"]["Enums"]["ticket_status"] | null
          ticket_url?: string | null
        }
        Update: {
          currency?: string | null
          event_id?: string
          id?: string
          is_free?: boolean | null
          name?: string
          price_max?: number | null
          price_min?: number | null
          status?: Database["public"]["Enums"]["ticket_status"] | null
          ticket_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ticket_offers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      venue_aliases: {
        Row: {
          alias: string
          id: string
          venue_id: string
        }
        Insert: {
          alias: string
          id?: string
          venue_id: string
        }
        Update: {
          alias?: string
          id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "venue_aliases_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string | null
          capacity: number | null
          city_id: string | null
          country_id: string | null
          cover_image_url: string | null
          created_at: string
          description: string | null
          id: string
          is_demo: boolean
          is_public: boolean
          is_verified: boolean
          latitude: number | null
          location: unknown
          longitude: number | null
          name: string
          postal_code: string | null
          slug: string
          updated_at: string
          website: string | null
        }
        Insert: {
          address?: string | null
          capacity?: number | null
          city_id?: string | null
          country_id?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_demo?: boolean
          is_public?: boolean
          is_verified?: boolean
          latitude?: number | null
          location?: unknown
          longitude?: number | null
          name: string
          postal_code?: string | null
          slug: string
          updated_at?: string
          website?: string | null
        }
        Update: {
          address?: string | null
          capacity?: number | null
          city_id?: string | null
          country_id?: string | null
          cover_image_url?: string | null
          created_at?: string
          description?: string | null
          id?: string
          is_demo?: boolean
          is_public?: boolean
          is_verified?: boolean
          latitude?: number | null
          location?: unknown
          longitude?: number | null
          name?: string
          postal_code?: string | null
          slug?: string
          updated_at?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venues_city_id_fkey"
            columns: ["city_id"]
            isOneToOne: false
            referencedRelation: "cities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venues_country_id_fkey"
            columns: ["country_id"]
            isOneToOne: false
            referencedRelation: "countries"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      create_organizer: {
        Args: { _name: string; _slug: string }
        Returns: string
      }
      disablelongtransactions: { Args: never; Returns: string }
      discover_events: {
        Args: {
          _category_slugs?: string[]
          _city_id?: string
          _free_only?: boolean
          _from?: string
          _lat?: number
          _limit?: number
          _lon?: number
          _offset?: number
          _query?: string
          _radius_km?: number
          _to?: string
        }
        Returns: {
          category_slug: string
          city_name: string
          cover_image_url: string
          distance_km: number
          ends_at: string
          event_id: string
          is_demo: boolean
          is_free: boolean
          is_verified: boolean
          occurrence_id: string
          short_description: string
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["event_status"]
          timezone: string
          title: string
          venue_name: string
        }[]
      }
      discover_map_events: {
        Args: {
          _category_slugs?: string[]
          _city_id?: string
          _free_only?: boolean
          _from?: string
          _lat?: number
          _limit?: number
          _lon?: number
          _offset?: number
          _query?: string
          _radius_km?: number
          _to?: string
        }
        Returns: {
          category_slug: string
          city_name: string
          cover_image_url: string
          distance_km: number
          ends_at: string
          event_id: string
          is_demo: boolean
          is_free: boolean
          is_verified: boolean
          latitude: number
          longitude: number
          occurrence_id: string
          short_description: string
          slug: string
          starts_at: string
          status: Database["public"]["Enums"]["event_status"]
          timezone: string
          title: string
          venue_name: string
        }[]
      }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      gettransactionid: { Args: never; Returns: unknown }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_organizer_member: {
        Args: { _org: string; _user: string }
        Returns: boolean
      }
      longtransactionsenabled: { Args: never; Returns: boolean }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      unaccent: { Args: { "": string }; Returns: string }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
    }
    Enums: {
      app_role: "user" | "organizer" | "moderator" | "admin"
      data_source_type:
        | "official_site"
        | "venue_site"
        | "organizer_site"
        | "partner_feed"
        | "manual"
        | "import"
      event_status:
        | "draft"
        | "pending_review"
        | "published"
        | "cancelled"
        | "postponed"
        | "sold_out"
        | "archived"
      ingestion_status:
        | "queued"
        | "running"
        | "completed"
        | "partially_completed"
        | "failed"
        | "cancelled"
        | "awaiting_review"
      occurrence_status:
        | "scheduled"
        | "cancelled"
        | "postponed"
        | "sold_out"
        | "completed"
      social_comment_status: "published" | "hidden"
      social_media_kind: "image" | "video"
      social_post_status: "draft" | "published" | "hidden"
      ticket_status:
        | "unknown"
        | "available"
        | "limited"
        | "sold_out"
        | "free"
        | "on_sale_soon"
      verification_level: "unverified" | "community" | "partner" | "official"
    }
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["user", "organizer", "moderator", "admin"],
      data_source_type: [
        "official_site",
        "venue_site",
        "organizer_site",
        "partner_feed",
        "manual",
        "import",
      ],
      event_status: [
        "draft",
        "pending_review",
        "published",
        "cancelled",
        "postponed",
        "sold_out",
        "archived",
      ],
      ingestion_status: [
        "queued",
        "running",
        "completed",
        "partially_completed",
        "failed",
        "cancelled",
        "awaiting_review",
      ],
      occurrence_status: [
        "scheduled",
        "cancelled",
        "postponed",
        "sold_out",
        "completed",
      ],
      social_comment_status: ["published", "hidden"],
      social_media_kind: ["image", "video"],
      social_post_status: ["draft", "published", "hidden"],
      ticket_status: [
        "unknown",
        "available",
        "limited",
        "sold_out",
        "free",
        "on_sale_soon",
      ],
      verification_level: ["unverified", "community", "partner", "official"],
    },
  },
} as const

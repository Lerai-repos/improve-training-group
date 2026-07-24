export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      config: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          updated_at: string
          value: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          value: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      klanten: {
        Row: {
          created_at: string
          deleted_at: string | null
          external_item_id: string | null
          id: string
          klantnaam: string
          source_system: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          external_item_id?: string | null
          id?: string
          klantnaam: string
          source_system?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          external_item_id?: string | null
          id?: string
          klantnaam?: string
          source_system?: string
          updated_at?: string
        }
        Relationships: []
      }
      label_config: {
        Row: {
          backpage_url: string | null
          created_at: string
          evaluatieformulier_url: string | null
          frontpage_url: string | null
          id: string
          kleur: string | null
          label: string
          logo_url: string | null
          rapportterm: string | null
          term: string | null
          updated_at: string
          volledige_naam: string | null
        }
        Insert: {
          backpage_url?: string | null
          created_at?: string
          evaluatieformulier_url?: string | null
          frontpage_url?: string | null
          id?: string
          kleur?: string | null
          label: string
          logo_url?: string | null
          rapportterm?: string | null
          term?: string | null
          updated_at?: string
          volledige_naam?: string | null
        }
        Update: {
          backpage_url?: string | null
          created_at?: string
          evaluatieformulier_url?: string | null
          frontpage_url?: string | null
          id?: string
          kleur?: string | null
          label?: string
          logo_url?: string | null
          rapportterm?: string | null
          term?: string | null
          updated_at?: string
          volledige_naam?: string | null
        }
        Relationships: []
      }
      rate_cards: {
        Row: {
          created_at: string
          currency: string
          hourly_rate_cents: number
          id: string
          rate_key: string
          trainer_id: string | null
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          created_at?: string
          currency?: string
          hourly_rate_cents: number
          id?: string
          rate_key: string
          trainer_id?: string | null
          updated_at?: string
          valid_from: string
          valid_until?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          hourly_rate_cents?: number
          id?: string
          rate_key?: string
          trainer_id?: string | null
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rate_cards_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainers"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          anomalies: Json | null
          artifact_counts: Json | null
          artifact_hash: string | null
          board_totals: Json | null
          config_hash: string | null
          failing_stage: string | null
          finished_at: string | null
          id: string
          mode: string
          monday_request_ids: Json | null
          schema_hash: string | null
          scope: Json
          started_at: string
          status: string
          target: string | null
        }
        Insert: {
          anomalies?: Json | null
          artifact_counts?: Json | null
          artifact_hash?: string | null
          board_totals?: Json | null
          config_hash?: string | null
          failing_stage?: string | null
          finished_at?: string | null
          id?: string
          mode: string
          monday_request_ids?: Json | null
          schema_hash?: string | null
          scope: Json
          started_at?: string
          status?: string
          target?: string | null
        }
        Update: {
          anomalies?: Json | null
          artifact_counts?: Json | null
          artifact_hash?: string | null
          board_totals?: Json | null
          config_hash?: string | null
          failing_stage?: string | null
          finished_at?: string | null
          id?: string
          mode?: string
          monday_request_ids?: Json | null
          schema_hash?: string | null
          scope?: Json
          started_at?: string
          status?: string
          target?: string | null
        }
        Relationships: []
      }
      themas: {
        Row: {
          created_at: string
          deleted_at: string | null
          external_board_id: string | null
          external_item_id: string | null
          id: string
          source_system: string
          thema: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          external_board_id?: string | null
          external_item_id?: string | null
          id?: string
          source_system?: string
          thema: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          external_board_id?: string | null
          external_item_id?: string | null
          id?: string
          source_system?: string
          thema?: string
          updated_at?: string
        }
        Relationships: []
      }
      trainer_theme_qual_observations: {
        Row: {
          colour: Database["public"]["Enums"]["qualification"]
          created_at: string
          id: string
          source_column: string | null
          thema_id: string
          trainer_id: string
        }
        Insert: {
          colour: Database["public"]["Enums"]["qualification"]
          created_at?: string
          id?: string
          source_column?: string | null
          thema_id: string
          trainer_id: string
        }
        Update: {
          colour?: Database["public"]["Enums"]["qualification"]
          created_at?: string
          id?: string
          source_column?: string | null
          thema_id?: string
          trainer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_theme_qual_observations_thema_id_fkey"
            columns: ["thema_id"]
            isOneToOne: false
            referencedRelation: "themas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_theme_qual_observations_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainers"
            referencedColumns: ["id"]
          },
        ]
      }
      trainer_theme_qualifications: {
        Row: {
          conflict_resolution: Json | null
          created_at: string
          effective_qualification:
            | Database["public"]["Enums"]["effective_qualification"]
            | null
          id: string
          thema_id: string
          trainer_id: string
          updated_at: string
        }
        Insert: {
          conflict_resolution?: Json | null
          created_at?: string
          effective_qualification?:
            | Database["public"]["Enums"]["effective_qualification"]
            | null
          id?: string
          thema_id: string
          trainer_id: string
          updated_at?: string
        }
        Update: {
          conflict_resolution?: Json | null
          created_at?: string
          effective_qualification?:
            | Database["public"]["Enums"]["effective_qualification"]
            | null
          id?: string
          thema_id?: string
          trainer_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trainer_theme_qualifications_thema_id_fkey"
            columns: ["thema_id"]
            isOneToOne: false
            referencedRelation: "themas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trainer_theme_qualifications_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainers"
            referencedColumns: ["id"]
          },
        ]
      }
      trainers: {
        Row: {
          adres: string | null
          created_at: string
          deleted_at: string | null
          email: string | null
          external_board_id: string | null
          external_item_id: string | null
          id: string
          monday_group: string | null
          naam: string
          rate_key: string | null
          source_system: string
          telefoon: string | null
          updated_at: string
        }
        Insert: {
          adres?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          external_board_id?: string | null
          external_item_id?: string | null
          id?: string
          monday_group?: string | null
          naam: string
          rate_key?: string | null
          source_system?: string
          telefoon?: string | null
          updated_at?: string
        }
        Update: {
          adres?: string | null
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          external_board_id?: string | null
          external_item_id?: string | null
          id?: string
          monday_group?: string | null
          naam?: string
          rate_key?: string | null
          source_system?: string
          telefoon?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      training_klanten: {
        Row: {
          created_at: string
          klant_id: string
          training_id: string
        }
        Insert: {
          created_at?: string
          klant_id: string
          training_id: string
        }
        Update: {
          created_at?: string
          klant_id?: string
          training_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_klanten_klant_id_fkey"
            columns: ["klant_id"]
            isOneToOne: false
            referencedRelation: "klanten"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_klanten_training_id_fkey"
            columns: ["training_id"]
            isOneToOne: false
            referencedRelation: "trainings"
            referencedColumns: ["id"]
          },
        ]
      }
      training_themas: {
        Row: {
          created_at: string
          thema_id: string
          training_id: string
        }
        Insert: {
          created_at?: string
          thema_id: string
          training_id: string
        }
        Update: {
          created_at?: string
          thema_id?: string
          training_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_themas_thema_id_fkey"
            columns: ["thema_id"]
            isOneToOne: false
            referencedRelation: "themas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_themas_training_id_fkey"
            columns: ["training_id"]
            isOneToOne: false
            referencedRelation: "trainings"
            referencedColumns: ["id"]
          },
        ]
      }
      training_trainers: {
        Row: {
          created_at: string
          trainer_id: string
          training_id: string
        }
        Insert: {
          created_at?: string
          trainer_id: string
          training_id: string
        }
        Update: {
          created_at?: string
          trainer_id?: string
          training_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "training_trainers_trainer_id_fkey"
            columns: ["trainer_id"]
            isOneToOne: false
            referencedRelation: "trainers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "training_trainers_training_id_fkey"
            columns: ["training_id"]
            isOneToOne: false
            referencedRelation: "trainings"
            referencedColumns: ["id"]
          },
        ]
      }
      trainings: {
        Row: {
          avg_concrete_tools_snapshot: number | null
          avg_overall_grade_snapshot: number | null
          avg_practical_work_snapshot: number | null
          avg_program_content_snapshot: number | null
          avg_trainer_communications_snapshot: number | null
          avg_trainer_competence_snapshot: number | null
          created_at: string
          datum: string | null
          deleted_at: string | null
          duur_training: number | null
          evaluatie_status: string | null
          evaluation_count_snapshot: number | null
          evaluation_snapshot_imported_at: string | null
          evaluation_snapshot_revision: string | null
          external_board_id: string | null
          external_group_id: string | null
          external_item_id: string | null
          id: string
          ie_code: string | null
          label: string | null
          locatie: string | null
          omzet_cents: number | null
          source_system: string
          status: string | null
          taal: string | null
          tijd: string | null
          updated_at: string
        }
        Insert: {
          avg_concrete_tools_snapshot?: number | null
          avg_overall_grade_snapshot?: number | null
          avg_practical_work_snapshot?: number | null
          avg_program_content_snapshot?: number | null
          avg_trainer_communications_snapshot?: number | null
          avg_trainer_competence_snapshot?: number | null
          created_at?: string
          datum?: string | null
          deleted_at?: string | null
          duur_training?: number | null
          evaluatie_status?: string | null
          evaluation_count_snapshot?: number | null
          evaluation_snapshot_imported_at?: string | null
          evaluation_snapshot_revision?: string | null
          external_board_id?: string | null
          external_group_id?: string | null
          external_item_id?: string | null
          id?: string
          ie_code?: string | null
          label?: string | null
          locatie?: string | null
          omzet_cents?: number | null
          source_system?: string
          status?: string | null
          taal?: string | null
          tijd?: string | null
          updated_at?: string
        }
        Update: {
          avg_concrete_tools_snapshot?: number | null
          avg_overall_grade_snapshot?: number | null
          avg_practical_work_snapshot?: number | null
          avg_program_content_snapshot?: number | null
          avg_trainer_communications_snapshot?: number | null
          avg_trainer_competence_snapshot?: number | null
          created_at?: string
          datum?: string | null
          deleted_at?: string | null
          duur_training?: number | null
          evaluatie_status?: string | null
          evaluation_count_snapshot?: number | null
          evaluation_snapshot_imported_at?: string | null
          evaluation_snapshot_revision?: string | null
          external_board_id?: string | null
          external_group_id?: string | null
          external_item_id?: string | null
          id?: string
          ie_code?: string | null
          label?: string | null
          locatie?: string | null
          omzet_cents?: number | null
          source_system?: string
          status?: string | null
          taal?: string | null
          tijd?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_monday_snapshot: {
        Args: { p_artifact: Json; p_run_id: string }
        Returns: Json
      }
      jsonb_content_md5: { Args: { p: Json }; Returns: string }
    }
    Enums: {
      effective_qualification: "green" | "red"
      qualification: "groen" | "oranje" | "rood" | "grijs"
    }
    CompositeTypes: {
      [_ in never]: never
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      effective_qualification: ["green", "red"],
      qualification: ["groen", "oranje", "rood", "grijs"],
    },
  },
} as const


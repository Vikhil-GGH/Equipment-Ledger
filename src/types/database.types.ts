// Hand-written to match supabase/migrations exactly (the CLI's `gen types`
// codepath needs a local Docker container, unavailable in this environment).
// If Docker/the CLI becomes available later, regenerate with:
//   npx supabase gen types typescript --db-url <connection-string> > src/types/database.types.ts
// and diff against this file before replacing it.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type UserRole = 'admin' | 'editor' | 'viewer' | 'scanner'

export type AssetStatus =
  | 'available'
  | 'provided'
  | 'retained'
  | 'damaged'
  | 'decommissioned'
  | 'nonfunctional'
  /** Final: the device can't be recovered (20260901000025). */
  | 'lost'

export type AssetAction =
  | 'provide'
  | 'retain'
  | 'mark_damaged'
  | 'collect'
  | 'transfer'
  | 'decommission'
  | 'mark_repaired'
  | 'mark_nonfunctional'

export type AssetCollection =
  | 'serialized_assets'
  | 'active_laptops_np'
  | 'monitors'
  | 'other_equipment'

export type BulkBucket =
  | 'available'
  | 'provided'
  | 'retained'
  | 'damaged'
  | 'decommissioned'

export type BulkAction =
  | 'receive_stock'
  | 'issue'
  | 'return'
  | 'retain'
  | 'mark_damaged'
  | 'repair'
  | 'decommission'

/** Offboarding laptop disposition (20260901000024). */
export type OffboardingLaptopOutcome = 'received' | 'retained' | 'decommissioned' | 'not_applicable'

/** Onboarding Yes / No / N/A answers; null = not answered yet (20260901000026). */
export type RequirementAnswer = 'yes' | 'no' | 'not_applicable'
/** Active Employees directory (20260901000028). null = not in the directory. */
export type EmploymentStatus = 'active' | 'inactive'

/** Equipment register row status (20260901000026). */
export type EquipmentIssueStatus =
  | 'open'
  | 'returned'
  | 'returned_damaged'
  | 'decommissioned'
  | 'retained_authorized'
  | 'lost'
  | 'transferred'
  | 'unassigned'

// NOTE: Table Row/Insert/Update types are written as inline object literals
// throughout this file, deliberately not factored into shared named
// interfaces (even though serialized_assets/active_laptops_np and their
// history tables are identical in shape). Supabase's generic Postgrest
// typing constrains Tables to `Record<string, GenericTable>`, and a named
// interface reference (as opposed to an inline literal) fails that
// constraint under this TypeScript version — silently degrading `.rpc()`
// argument types to `undefined`. Keep every Row/Insert/Update below as an
// inline literal; don't reintroduce a shared interface here.

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string | null
          role: UserRole
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          full_name?: string | null
          role?: UserRole
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          full_name?: string | null
          role?: UserRole
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      serialized_assets: {
        Row: {
          id: string
          name: string
          category: string
          serial: string
          status: AssetStatus
          assigned_to: string | null
          location: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          category: string
          serial: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          category?: string
          serial?: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      serialized_asset_history: {
        Row: {
          id: string
          asset_id: string
          date: string
          action: string
          detail: string | null
          actor_user_id: string | null
        }
        Insert: {
          id?: string
          asset_id: string
          date?: string
          action: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Update: {
          id?: string
          asset_id?: string
          date?: string
          action?: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'serialized_asset_history_asset_id_fkey'
            columns: ['asset_id']
            isOneToOne: false
            referencedRelation: 'serialized_assets'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'serialized_asset_history_actor_user_id_fkey'
            columns: ['actor_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      active_laptops_np: {
        Row: {
          id: string
          name: string
          category: string
          serial: string
          status: AssetStatus
          assigned_to: string | null
          location: string | null
          created_at: string
          updated_at: string
          moved_from_inventory: boolean
        }
        Insert: {
          id?: string
          name: string
          category: string
          serial: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
          moved_from_inventory?: boolean
        }
        Update: {
          id?: string
          name?: string
          category?: string
          serial?: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
          moved_from_inventory?: boolean
        }
        Relationships: []
      }
      active_laptops_np_history: {
        Row: {
          id: string
          asset_id: string
          date: string
          action: string
          detail: string | null
          actor_user_id: string | null
        }
        Insert: {
          id?: string
          asset_id: string
          date?: string
          action: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Update: {
          id?: string
          asset_id?: string
          date?: string
          action?: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'active_laptops_np_history_asset_id_fkey'
            columns: ['asset_id']
            isOneToOne: false
            referencedRelation: 'active_laptops_np'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'active_laptops_np_history_actor_user_id_fkey'
            columns: ['actor_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      monitors: {
        Row: {
          id: string
          name: string
          category: string
          serial: string
          status: AssetStatus
          assigned_to: string | null
          location: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          category: string
          serial: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          category?: string
          serial?: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      monitors_history: {
        Row: {
          id: string
          asset_id: string
          date: string
          action: string
          detail: string | null
          actor_user_id: string | null
        }
        Insert: {
          id?: string
          asset_id: string
          date?: string
          action: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Update: {
          id?: string
          asset_id?: string
          date?: string
          action?: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'monitors_history_asset_id_fkey'
            columns: ['asset_id']
            isOneToOne: false
            referencedRelation: 'monitors'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'monitors_history_actor_user_id_fkey'
            columns: ['actor_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      other_equipment: {
        Row: {
          id: string
          name: string
          category: string
          serial: string
          status: AssetStatus
          assigned_to: string | null
          location: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          category: string
          serial: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          name?: string
          category?: string
          serial?: string
          status?: AssetStatus
          assigned_to?: string | null
          location?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      other_equipment_history: {
        Row: {
          id: string
          asset_id: string
          date: string
          action: string
          detail: string | null
          actor_user_id: string | null
        }
        Insert: {
          id?: string
          asset_id: string
          date?: string
          action: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Update: {
          id?: string
          asset_id?: string
          date?: string
          action?: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'other_equipment_history_asset_id_fkey'
            columns: ['asset_id']
            isOneToOne: false
            referencedRelation: 'other_equipment'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'other_equipment_history_actor_user_id_fkey'
            columns: ['actor_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      bulk_items: {
        Row: {
          id: string
          name: string
          category: string
          location: string | null
          available: number
          provided: number
          retained: number
          damaged: number
          decommissioned: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          category: string
          location?: string | null
          available?: number
          provided?: number
          retained?: number
          damaged?: number
          decommissioned?: number
          created_at?: string
          updated_at?: string
        }
        Update: Partial<{
          id: string
          name: string
          category: string
          location: string | null
          available: number
          provided: number
          retained: number
          damaged: number
          decommissioned: number
          created_at: string
          updated_at: string
        }>
        Relationships: []
      }
      bulk_item_history: {
        Row: {
          id: string
          item_id: string
          date: string
          action: string
          detail: string | null
          quantity: number
          actor_user_id: string | null
        }
        Insert: {
          id?: string
          item_id: string
          date?: string
          action: string
          detail?: string | null
          quantity: number
          actor_user_id?: string | null
        }
        Update: Partial<{
          id: string
          item_id: string
          date: string
          action: string
          detail: string | null
          quantity: number
          actor_user_id: string | null
        }>
        Relationships: [
          {
            foreignKeyName: 'bulk_item_history_item_id_fkey'
            columns: ['item_id']
            isOneToOne: false
            referencedRelation: 'bulk_items'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'bulk_item_history_actor_user_id_fkey'
            columns: ['actor_user_id']
            isOneToOne: false
            referencedRelation: 'profiles'
            referencedColumns: ['id']
          },
        ]
      }
      import_events: {
        Row: {
          id: string
          imported_by: string | null
          imported_at: string
          target_collection: string
          filename: string
          rows_created: number
          rows_updated: number
          rows_errored: number
          summary: Json | null
        }
        Insert: {
          id?: string
          imported_by?: string | null
          imported_at?: string
          target_collection: string
          filename: string
          rows_created?: number
          rows_updated?: number
          rows_errored?: number
          summary?: Json | null
        }
        Update: Partial<{
          id: string
          imported_by: string | null
          imported_at: string
          target_collection: string
          filename: string
          rows_created: number
          rows_updated: number
          rows_errored: number
          summary: Json | null
        }>
        Relationships: []
      }
      onboarding_checklists: {
        Row: {
          id: string
          employee_name: string
          identity_created: boolean
          equipment_assigned: boolean
          required_access_provided: boolean
          onboarding_successful: boolean
          assigned_asset_id: string | null
          employee_id: string | null
          requested_laptop: string | null
          charger_required: RequirementAnswer | null
          headset_required: RequirementAnswer | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          employee_name: string
          identity_created?: boolean
          equipment_assigned?: boolean
          required_access_provided?: boolean
          onboarding_successful?: boolean
          assigned_asset_id?: string | null
          employee_id?: string | null
          requested_laptop?: string | null
          charger_required?: RequirementAnswer | null
          headset_required?: RequirementAnswer | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<{
          id: string
          employee_name: string
          identity_created: boolean
          equipment_assigned: boolean
          required_access_provided: boolean
          onboarding_successful: boolean
          assigned_asset_id: string | null
          employee_id: string | null
          requested_laptop: string | null
          charger_required: RequirementAnswer | null
          headset_required: RequirementAnswer | null
          created_by: string | null
          created_at: string
          updated_at: string
        }>
        Relationships: [
          {
            foreignKeyName: 'onboarding_checklists_assigned_asset_id_fkey'
            columns: ['assigned_asset_id']
            isOneToOne: false
            referencedRelation: 'active_laptops_np'
            referencedColumns: ['id']
          },
        ]
      }
      offboarding_checklists: {
        Row: {
          id: string
          employee_name: string
          removed_access: boolean
          laptop_received: boolean
          laptop_retained: boolean
          laptop_decommissioned: boolean
          laptop_outcome: OffboardingLaptopOutcome | null
          outcome_needs_review: boolean
          employee_id: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          employee_name: string
          removed_access?: boolean
          laptop_received?: boolean
          laptop_retained?: boolean
          laptop_decommissioned?: boolean
          laptop_outcome?: OffboardingLaptopOutcome | null
          outcome_needs_review?: boolean
          employee_id?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<{
          id: string
          employee_name: string
          removed_access: boolean
          laptop_received: boolean
          laptop_retained: boolean
          laptop_decommissioned: boolean
          laptop_outcome: OffboardingLaptopOutcome | null
          outcome_needs_review: boolean
          employee_id: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }>
        Relationships: []
      }
      employees: {
        Row: {
          id: string
          full_name: string
          name_key: string | null
          /** Work email address (unique once trimmed and lower-cased — email_key). */
          email: string | null
          created_by: string | null
          created_at: string
          // Active Employees directory (20260901000028); absent before it.
          first_name?: string | null
          last_name?: string | null
          department?: string | null
          job_title?: string | null
          hr_status?: string | null
          manager?: string | null
          start_date?: string | null
          employment_status?: EmploymentStatus | null
          reactivation_pending?: boolean
          status_decision_required?: boolean
          status_changed_at?: string | null
          updated_at?: string | null
          email_key?: string | null
        }
        // Written only by the database functions (save_employee, imports, triggers).
        Insert: { [key: string]: never }
        Update: { [key: string]: never }
        Relationships: []
      }
      employee_history: {
        Row: {
          id: string
          employee_id: string
          kind: 'created' | 'status' | 'details' | 'reactivation_pending' | 'decision_required'
          from_status: EmploymentStatus | null
          to_status: EmploymentStatus | null
          changes: Json | null
          source: string
          note: string | null
          onboarding_id: string | null
          offboarding_id: string | null
          import_filename: string | null
          actor_user_id: string | null
          at: string
        }
        Insert: { [key: string]: never }
        Update: { [key: string]: never }
        Relationships: []
      }
      equipment_issues: {
        Row: {
          id: string
          employee_id: string | null
          assignee_name: string
          employee_ambiguous: boolean
          item_kind: 'serialized' | 'bulk'
          asset_collection: AssetCollection | null
          asset_id: string | null
          bulk_item_id: string | null
          quantity: number
          description: string
          serial: string | null
          issued_at: string
          issued_by: string | null
          onboarding_id: string | null
          status: EquipmentIssueStatus
          closed_at: string | null
          closed_by: string | null
          close_note: string | null
          approved_by: string | null
          offboarding_id: string | null
          source: 'issue' | 'lifecycle' | 'import' | 'backfill' | 'restore'
          created_at: string
        }
        // Written only by the database (trigger + functions).
        Insert: { [key: string]: never }
        Update: { [key: string]: never }
        Relationships: []
      }
    }
    Views: {
      // 20260901000027: existing devices that share a normalized serial (or
      // have none), kept as they are, for review only.
      serial_duplicate_candidates: {
        Row: {
          serial_key: string
          collection: AssetCollection
          asset_id: string
          serial: string
          status: AssetStatus
          assigned_to: string | null
          reason: string
        }
        Relationships: []
      }
      employee_possible_duplicates: {
        Row: {
          employee_id: string
          full_name: string
          other_employee_id: string
          other_full_name: string
          reason: string
        }
        Relationships: []
      }
      equipment_register_mismatches: {
        Row: {
          collection: AssetCollection
          asset_id: string
          serial: string
          assigned_to: string | null
          register_assignee: string | null
        }
        Relationships: []
      }
      serialized_assets_stats: {
        Row: { status: AssetStatus | null; count: number | null }
        Relationships: []
      }
      active_laptops_np_stats: {
        Row: { status: AssetStatus | null; count: number | null }
        Relationships: []
      }
      monitors_stats: {
        Row: { status: AssetStatus | null; count: number | null }
        Relationships: []
      }
      other_equipment_stats: {
        Row: { status: AssetStatus | null; count: number | null }
        Relationships: []
      }
      bulk_stock_stats: {
        Row: {
          available: number | null
          provided: number | null
          retained: number | null
          damaged: number | null
          decommissioned: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      my_role: { Args: Record<string, never>; Returns: UserRole }
      is_admin: { Args: Record<string, never>; Returns: boolean }
      is_editor_or_admin: { Args: Record<string, never>; Returns: boolean }
      is_known_user: { Args: Record<string, never>; Returns: boolean }
      create_asset: {
        Args: {
          [key: string]: unknown
          p_collection: AssetCollection
          p_name: string
          p_category: string
          p_serial: string
          p_status?: AssetStatus
          p_assigned_to?: string | null
          p_location?: string | null
        }
        Returns: string
      }
      perform_lifecycle_action: {
        Args: {
          [key: string]: unknown
          p_collection: AssetCollection
          p_asset_id: string
          p_action: AssetAction
          p_assigned_to?: string | null
          p_detail?: string | null
          p_refresh_confirmed?: boolean
        }
        Returns: AssetCollection
      }
      perform_swap: {
        Args: {
          [key: string]: unknown
          p_collection: AssetCollection
          p_old_asset_id: string
          p_new_asset_id: string
          p_reason: string
          p_refresh_confirmed?: boolean
        }
        Returns: AssetCollection
      }
      onboarding_assign_device: {
        Args: {
          [key: string]: unknown
          p_onboarding_id: string
          p_serial: string
          p_name?: string | null
          p_category?: string | null
          p_location?: string | null
        }
        Returns: string
      }
      create_bulk_item: {
        Args: {
          [key: string]: unknown
          p_name: string
          p_category: string
          p_location?: string | null
          p_initial_quantity?: number
        }
        Returns: string
      }
      perform_bulk_action: {
        Args: {
          [key: string]: unknown
          p_item_id: string
          p_action: BulkAction
          p_quantity: number
          p_from_bucket?: BulkBucket | null
          p_detail?: string | null
        }
        Returns: undefined
      }
      commit_asset_import: {
        Args: {
          [key: string]: unknown
          p_collection: AssetCollection
          p_filename: string
          p_rows: Json
        }
        Returns: Json
      }
      commit_bulk_import: {
        Args: {
          [key: string]: unknown
          p_confirm_repeat?: boolean
          p_filename: string
          p_rows: Json
        }
        Returns: Json
      }
      revoke_user_access: {
        Args: { [key: string]: unknown; p_user_id: string; p_reason?: string | null }
        Returns: undefined
      }
      restore_user_access: {
        Args: { [key: string]: unknown; p_user_id: string; p_reason?: string | null }
        Returns: undefined
      }
      save_employee: {
        Args: { [key: string]: unknown; p_employee_id: string | null; p_fields: Json; p_status?: EmploymentStatus | null }
        Returns: string
      }
      set_employment_status: {
        Args: { [key: string]: unknown; p_employee_id: string; p_status: EmploymentStatus; p_note?: string | null }
        Returns: boolean
      }
      commit_employee_import: {
        Args: { [key: string]: unknown; p_filename: string; p_rows: Json }
        Returns: Json
      }
      restore_backup: {
        Args: {
          [key: string]: unknown
          p_payload: Json
        }
        Returns: Json
      }
      create_employee: {
        Args: {
          [key: string]: unknown
          p_full_name: string
          p_email?: string | null
        }
        Returns: string
      }
      issue_equipment: {
        Args: {
          [key: string]: unknown
          p_employee_id: string
          p_collection?: AssetCollection | null
          p_asset_id?: string | null
          p_bulk_item_id?: string | null
          p_quantity?: number
          p_onboarding_id?: string | null
          p_note?: string | null
        }
        Returns: string
      }
      return_equipment: {
        Args: {
          [key: string]: unknown
          p_issue_id: string
          p_outcome: EquipmentIssueStatus
          p_quantity?: number | null
          p_note?: string | null
          p_offboarding_id?: string | null
        }
        Returns: string
      }
    }
    Enums: {
      user_role: UserRole
      asset_status: AssetStatus
      asset_action: AssetAction
      asset_collection: AssetCollection
      bulk_bucket: BulkBucket
      bulk_action: BulkAction
      offboarding_laptop_outcome: OffboardingLaptopOutcome
      requirement_answer: RequirementAnswer
      equipment_issue_status: EquipmentIssueStatus
    }
  }
}

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

export type AssetAction =
  | 'provide'
  | 'retain'
  | 'mark_damaged'
  | 'collect'
  | 'transfer'
  | 'decommission'
  | 'mark_repaired'
  | 'mark_nonfunctional'

export type AssetCollection = 'serialized_assets' | 'active_laptops_np'

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
          created_by: string | null
          created_at: string
          updated_at: string
        }>
        Relationships: []
      }
    }
    Views: {
      serialized_assets_stats: {
        Row: { status: AssetStatus | null; count: number | null }
        Relationships: []
      }
      active_laptops_np_stats: {
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
        }
        Returns: undefined
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
    }
    Enums: {
      user_role: UserRole
      asset_status: AssetStatus
      asset_action: AssetAction
      asset_collection: AssetCollection
      bulk_bucket: BulkBucket
      bulk_action: BulkAction
    }
  }
}

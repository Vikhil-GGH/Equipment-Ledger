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

interface SerializedAssetRow {
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

interface AssetHistoryRow {
  id: string
  asset_id: string
  date: string
  action: string
  detail: string | null
  actor_user_id: string | null
}

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
        Row: SerializedAssetRow
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
        Update: Partial<SerializedAssetRow>
        Relationships: []
      }
      serialized_asset_history: {
        Row: AssetHistoryRow
        Insert: {
          id?: string
          asset_id: string
          date?: string
          action: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Update: Partial<AssetHistoryRow>
        Relationships: [
          {
            foreignKeyName: 'serialized_asset_history_asset_id_fkey'
            columns: ['asset_id']
            isOneToOne: false
            referencedRelation: 'serialized_assets'
            referencedColumns: ['id']
          },
        ]
      }
      active_laptops_np: {
        Row: SerializedAssetRow
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
        Update: Partial<SerializedAssetRow>
        Relationships: []
      }
      active_laptops_np_history: {
        Row: AssetHistoryRow
        Insert: {
          id?: string
          asset_id: string
          date?: string
          action: string
          detail?: string | null
          actor_user_id?: string | null
        }
        Update: Partial<AssetHistoryRow>
        Relationships: [
          {
            foreignKeyName: 'active_laptops_np_history_asset_id_fkey'
            columns: ['asset_id']
            isOneToOne: false
            referencedRelation: 'active_laptops_np'
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

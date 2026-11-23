# مخطط علاقات قاعدة بيانات MowxBack

```mermaid
erDiagram
    PROFIT_TRANSACTIONS ||--|{ PROFIT_LINES : contains
    ITEMS o|--o{ PROFIT_LINES : optional_catalog_reference
    WORKERS ||--o{ WITHDRAWALS : linked_by
    EXPENSE_CATEGORIES ||--o{ EXPENSES : categorized_by

    PROFIT_TRANSACTIONS {
        TEXT id PK
        TEXT tx_date
        TEXT created_at
        TEXT updated_at
        TEXT deleted_at
    }
    PROFIT_LINES {
        TEXT id PK
        TEXT transaction_id FK
        TEXT item_id FK "nullable"
        TEXT legacy_ref_id
        TEXT item_name
        INTEGER quantity_micros
        INTEGER amount_milli
        TEXT notes
        TEXT deleted_at
    }
    EXPENSES {
        TEXT id PK
        TEXT tx_date
        TEXT category_id FK
        TEXT category_name_snapshot
        INTEGER amount_milli
        TEXT description
        TEXT notes
        TEXT deleted_at
    }
    WITHDRAWALS {
        TEXT id PK
        TEXT tx_date
        TEXT worker_id FK
        TEXT worker_name_snapshot
        INTEGER amount_milli
        TEXT notes
        TEXT deleted_at
    }
    ITEMS {
        TEXT id PK
        TEXT name
        INTEGER is_active
        TEXT deleted_at
    }
    WORKERS {
        TEXT id PK
        TEXT name
        INTEGER is_active
        TEXT deleted_at
    }
    EXPENSE_CATEGORIES {
        TEXT id PK
        TEXT name
        INTEGER is_active
        TEXT deleted_at
    }
    NAME_SUGGESTIONS {
        INTEGER id PK
        TEXT normalized_name UK
        TEXT display_name
        TEXT first_used_at
        TEXT last_used_at
        INTEGER use_count
    }
    AUDIT_LOG {
        TEXT id PK
        TEXT entity_type
        TEXT entity_id
        TEXT parent_entity_id
        TEXT action
        TEXT before_json
        TEXT after_json
        TEXT occurred_at_utc
    }
    APP_SETTINGS {
        TEXT setting_key PK
        TEXT value_json
        TEXT updated_at
    }
    SCHEMA_MIGRATIONS {
        INTEGER version PK
        TEXT name
        TEXT checksum
        TEXT applied_at_utc
    }
    LEGACY_IMPORTS {
        TEXT content_sha256 PK
        INTEGER external_schema
        INTEGER internal_version
        TEXT exported_at
        TEXT imported_at_utc
        TEXT source_name
    }
```

## ملاحظات على العلاقات

- علاقة رأس حركة الأرباح إلى السطور واحد إلى متعدد، ولا تنشأ حركة أرباح من دون سطر فعال في التقارير.
- علاقة `profit_lines.item_id` اختيارية فقط. اسم الصنف الحر محفوظ في السطر نفسه، لذا لا يتطلب سجل إدارة أصناف.
- المصروف مرتبط بتصنيف عبر FK، والسحبية مرتبطة بعامل عبر FK.
- جداول الإدارة لا تملك علاقة مباشرة مع الاقتراحات؛ `name_suggestions` قاموس مستقل.
- `audit_log` يسجل أنواع الكيانات والمعرفات السابقة/اللاحقة كـ snapshots JSON؛ هذه علاقة تدقيق مرنة وليست بديلاً عن مفاتيح المعاملات المالية.
- Views `v_all_transactions` و`v_daily_totals` و`v_profit_by_item` وملخص التصنيف والعامل هي طبقة عرض للحساب، وليست جداول إضافية.

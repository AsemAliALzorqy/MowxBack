import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / 'database' / 'migrations' / '001_initial.sql'
AUDIT_MIGRATION = ROOT / 'database' / 'migrations' / '002_audit_log_append_only.sql'
TELEGRAM_MIGRATION = ROOT / 'database' / 'migrations' / '003_telegram_notifications.sql'
NOW = '2026-11-23T18:00:00.000Z'


class MowxBackDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys = ON')
        self.db.executescript(MIGRATION.read_text(encoding='utf-8'))
        self.db.executescript(AUDIT_MIGRATION.read_text(encoding='utf-8'))
        self.db.executescript(TELEGRAM_MIGRATION.read_text(encoding='utf-8'))
        self.db.execute("INSERT INTO items(id,name,is_active,created_at,updated_at) VALUES ('item-1','صنف تجريبي',1,?,?)", (NOW, NOW))
        self.db.execute("INSERT INTO workers(id,name,is_active,created_at,updated_at) VALUES ('worker-1','عامل تجريبي',1,?,?)", (NOW, NOW))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_profit(self, tx_id='profit-1', date='2026-11-23', lines=None):
        self.db.execute('INSERT INTO profit_transactions(id,tx_date,created_at,updated_at) VALUES (?,?,?,?)', (tx_id, date, NOW, NOW))
        for line in (lines or []):
            self.db.execute('''INSERT INTO profit_lines
                (id,transaction_id,item_id,legacy_ref_id,item_name,quantity_micros,amount_milli,notes,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)''', (
                    line['id'], tx_id, line.get('item_id'), line.get('legacy_ref_id'), line['name'],
                    line['qty'], line['amount'], line.get('notes', ''), NOW, NOW,
                ))
        self.db.commit()

    def test_integrity_and_foreign_key_checks(self):
        self.assertEqual(self.db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_schema_migrations_table_is_part_of_the_database(self):
        columns = {row['name'] for row in self.db.execute('PRAGMA table_info(schema_migrations)')}
        self.assertEqual(columns, {'version', 'name', 'checksum', 'applied_at_utc'})

    def test_initial_operational_categories_only_no_demo_transactions(self):
        cats = {r['name'] for r in self.db.execute('SELECT name FROM expense_categories')}
        self.assertEqual(cats, {'الطعام', 'المحروقات', 'الصيانة والأعطال'})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM profit_transactions').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM workers').fetchone()[0], 1)  # test fixture only

    def test_transaction_rolls_back_parent_and_all_lines_on_failure(self):
        with self.assertRaises(sqlite3.IntegrityError):
            with self.db:
                self.db.execute('''INSERT INTO profit_transactions(id,tx_date,created_at,updated_at)
                    VALUES ('profit-rollback','2026-11-23',?,?)''', (NOW, NOW))
                self.db.execute('''INSERT INTO profit_lines(id,transaction_id,item_id,item_name,quantity_micros,amount_milli,created_at,updated_at)
                    VALUES ('line-valid','profit-rollback','item-1','صنف صحيح',1000000,1000,?,?)''', (NOW, NOW))
                self.db.execute('''INSERT INTO profit_lines(id,transaction_id,item_id,item_name,quantity_micros,amount_milli,created_at,updated_at)
                    VALUES ('line-invalid','profit-rollback','missing-item','صنف خاطئ',1000000,1000,?,?)''', (NOW, NOW))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM profit_transactions WHERE id='profit-rollback'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM profit_lines WHERE transaction_id='profit-rollback'").fetchone()[0], 0)

    def test_single_profit_movement(self):
        self.add_profit(lines=[{'id': 'line-1', 'item_id': 'item-1', 'legacy_ref_id': 'item-1', 'name': 'صنف تجريبي', 'qty': 2_000_000, 'amount': 12_500}])
        row = self.db.execute('SELECT * FROM v_profit_transaction_totals WHERE id=?', ('profit-1',)).fetchone()
        self.assertEqual(row['line_count'], 1)
        self.assertEqual(row['quantity_micros'], 2_000_000)
        self.assertEqual(row['amount_milli'], 12_500)
        self.assertEqual(row['display_name'], 'صنف تجريبي')

    def test_multi_line_profit_is_one_transaction_and_sums(self):
        self.add_profit(lines=[
            {'id': 'line-1', 'name': 'صنف أ', 'qty': 1_500_000, 'amount': 10_250},
            {'id': 'line-2', 'name': 'صنف ب', 'qty': 2_000_000, 'amount': 20_500},
        ])
        rows = self.db.execute("SELECT * FROM v_all_transactions WHERE type='profit'").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['line_count'], 2)
        self.assertEqual(rows[0]['quantity_micros'], 3_500_000)
        self.assertEqual(rows[0]['amount_milli'], 30_750)
        self.assertEqual(rows[0]['name'], 'حركة أرباح أصناف')

    def test_edit_and_delete_one_profit_line_recalculate(self):
        self.add_profit(lines=[
            {'id': 'line-1', 'name': 'صنف أ', 'qty': 1_000_000, 'amount': 10_000},
            {'id': 'line-2', 'name': 'صنف ب', 'qty': 2_000_000, 'amount': 20_000},
        ])
        self.db.execute('UPDATE profit_lines SET quantity_micros=?, amount_milli=?, updated_at=? WHERE id=?', (3_000_000, 30_000, NOW, 'line-1'))
        self.db.execute('UPDATE profit_lines SET deleted_at=? WHERE id=?', (NOW, 'line-2'))
        self.db.commit()
        row = self.db.execute('SELECT * FROM v_profit_transaction_totals WHERE id=?', ('profit-1',)).fetchone()
        self.assertEqual(row['line_count'], 1)
        self.assertEqual(row['quantity_micros'], 3_000_000)
        self.assertEqual(row['amount_milli'], 30_000)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM profit_lines').fetchone()[0], 2)

    def test_all_lines_deleted_hides_movement_but_keeps_history(self):
        self.add_profit(lines=[{'id': 'line-1', 'name': 'صنف أ', 'qty': 1_000_000, 'amount': 10_000}])
        self.db.execute('UPDATE profit_lines SET deleted_at=? WHERE transaction_id=?', (NOW, 'profit-1'))
        self.db.commit()
        self.assertIsNone(self.db.execute('SELECT * FROM v_profit_transaction_totals WHERE id=?', ('profit-1',)).fetchone())
        self.assertIsNone(self.db.execute("SELECT * FROM v_all_transactions WHERE id='profit-1'").fetchone())
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM profit_transactions').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM profit_lines').fetchone()[0], 1)

    def test_withdrawals_are_included_once_in_total_expenses(self):
        self.add_profit(lines=[{'id': 'line-1', 'name': 'صنف أ', 'qty': 1_000_000, 'amount': 100_000}])
        self.db.execute('''INSERT INTO expenses(id,tx_date,category_id,category_name_snapshot,amount_milli,description,notes,created_at,updated_at)
            VALUES ('expense-1','2026-11-23','builtin-food','الطعام',20_000,'وجبة','',?,?)''', (NOW, NOW))
        self.db.execute('''INSERT INTO withdrawals(id,tx_date,worker_id,worker_name_snapshot,amount_milli,notes,created_at,updated_at)
            VALUES ('withdrawal-1','2026-11-23','worker-1','عامل تجريبي',15_000,'',?,?)''', (NOW, NOW))
        self.db.commit()
        row = self.db.execute('SELECT * FROM v_daily_totals WHERE tx_date=?', ('2026-11-23',)).fetchone()
        self.assertEqual(row['profit_milli'], 100_000)
        self.assertEqual(row['expense_milli'], 20_000)
        self.assertEqual(row['withdrawal_milli'], 15_000)
        self.assertEqual(row['total_expense_milli'], 35_000)
        self.assertEqual(row['net_milli'], 65_000)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM v_all_transactions').fetchone()[0], 3)

    def test_catalog_deactivation_does_not_break_historical_rows(self):
        self.db.execute('''INSERT INTO withdrawals(id,tx_date,worker_id,worker_name_snapshot,amount_milli,notes,created_at,updated_at)
            VALUES ('withdrawal-1','2026-11-23','worker-1','عامل تجريبي',5000,'',?,?)''', (NOW, NOW))
        self.db.execute("UPDATE workers SET is_active=0 WHERE id='worker-1'")
        self.db.commit()
        row = self.db.execute("SELECT worker_name_snapshot FROM withdrawals WHERE id='withdrawal-1'").fetchone()
        self.assertEqual(row['worker_name_snapshot'], 'عامل تجريبي')

    def test_constraints_reject_invalid_amount_and_missing_foreign_key(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('''INSERT INTO expenses(id,tx_date,category_id,category_name_snapshot,amount_milli,description,created_at,updated_at)
                VALUES ('e-zero','2026-11-23','builtin-food','الطعام',0,'',?,?)''', (NOW, NOW))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('''INSERT INTO withdrawals(id,tx_date,worker_id,worker_name_snapshot,amount_milli,created_at,updated_at)
                VALUES ('w-missing','2026-11-23','absent','غير موجود',1000,?,?)''', (NOW, NOW))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('''INSERT INTO expenses(id,tx_date,category_id,category_name_snapshot,amount_milli,description,created_at,updated_at)
                VALUES ('e-fraction','2026-11-23','builtin-food','الطعام',1.5,'وجبة',?,?)''', (NOW, NOW))
        self.db.execute('''INSERT INTO profit_transactions(id,tx_date,created_at,updated_at)
            VALUES ('p-fraction','2026-11-23',?,?)''', (NOW, NOW))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('''INSERT INTO profit_lines(id,transaction_id,item_name,quantity_micros,amount_milli,created_at,updated_at)
                VALUES ('l-fraction','p-fraction','صنف',1.5,1000,?,?)''', (NOW, NOW))

    def test_calendar_date_constraints_reject_impossible_dates(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('''INSERT INTO profit_transactions(id,tx_date,created_at,updated_at)
                VALUES ('p-invalid','2026-02-29',?,?)''', (NOW, NOW))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute('''INSERT INTO expenses(id,tx_date,category_id,category_name_snapshot,amount_milli,description,created_at,updated_at)
                VALUES ('e-invalid','2026-04-31','builtin-food','الطعام',1000,'وجبة',?,?)''', (NOW, NOW))
        self.db.execute('''INSERT INTO profit_transactions(id,tx_date,created_at,updated_at)
            VALUES ('p-leap','2024-02-29',?,?)''', (NOW, NOW))

    def test_report_date_filter_and_item_aggregation(self):
        self.add_profit(lines=[
            {'id': 'line-1', 'name': 'منتج واحد', 'qty': 1_000_000, 'amount': 1_250},
            {'id': 'line-2', 'name': 'منتج واحد', 'qty': 2_000_000, 'amount': 2_500},
        ])
        row = self.db.execute("SELECT * FROM v_profit_by_item WHERE tx_date BETWEEN '2026-11-01' AND '2026-11-30'").fetchone()
        self.assertEqual(row['quantity_micros'], 3_000_000)
        self.assertEqual(row['amount_milli'], 3_750)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM v_profit_by_item WHERE tx_date='2026-10-31'").fetchone()[0], 0)

    def test_name_suggestions_are_independent_from_items(self):
        self.db.execute('''INSERT INTO name_suggestions(normalized_name,display_name,first_used_at,last_used_at,use_count)
            VALUES ('منتج جديد','منتج جديد',?, ?, 1)''', (NOW, NOW))
        self.db.commit()
        self.assertIsNone(self.db.execute("SELECT * FROM items WHERE name='منتج جديد'").fetchone())
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM name_suggestions WHERE normalized_name='منتج جديد'").fetchone()[0], 1)

    def test_audit_log_stores_before_and_after_json(self):
        self.db.execute('''INSERT INTO audit_log(id,entity_type,entity_id,action,before_json,after_json,occurred_at_utc)
            VALUES ('log-1','expense','expense-1','update','{"amount":10}','{"amount":12}',?)''', (NOW,))
        self.db.commit()
        row = self.db.execute("SELECT before_json,after_json FROM audit_log WHERE id='log-1'").fetchone()
        self.assertEqual(row['before_json'], '{"amount":10}')
        self.assertEqual(row['after_json'], '{"amount":12}')

    def test_audit_append_only_migration_preserves_history_and_blocks_mutation(self):
        legacy = sqlite3.connect(':memory:')
        legacy.row_factory = sqlite3.Row
        legacy.executescript(MIGRATION.read_text(encoding='utf-8'))
        legacy.execute('''INSERT INTO audit_log(id,entity_type,entity_id,action,before_json,after_json,occurred_at_utc)
            VALUES ('legacy-log-1','item','item-1','update','{"name":"قبل"}','{"name":"بعد"}',?)''', (NOW,))
        legacy.commit()
        legacy.executescript(AUDIT_MIGRATION.read_text(encoding='utf-8'))
        saved = legacy.execute("SELECT action,before_json,after_json FROM audit_log WHERE id='legacy-log-1'").fetchone()
        self.assertEqual(saved['action'], 'update')
        self.assertEqual(saved['before_json'], '{"name":"قبل"}')
        self.assertEqual(saved['after_json'], '{"name":"بعد"}')
        legacy.execute('''INSERT INTO audit_log(id,entity_type,entity_id,action,after_json,occurred_at_utc)
            VALUES ('new-report-log','system','report-1','report_export','{"fileName":"test.pdf"}',?)''', (NOW,))
        with self.assertRaises(sqlite3.IntegrityError):
            legacy.execute("UPDATE audit_log SET action='create' WHERE id='legacy-log-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            legacy.execute("DELETE FROM audit_log WHERE id='legacy-log-1'")
        self.assertEqual(legacy.execute('SELECT COUNT(*) FROM audit_log').fetchone()[0], 2)
        legacy.close()


    def test_telegram_migration_preserves_workers_and_withdrawals(self):
        self.db.execute("UPDATE workers SET phone=? WHERE id='worker-1'", ('+962790000000',))
        self.db.execute("INSERT INTO withdrawals(id,tx_date,worker_id,worker_name_snapshot,amount_milli,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                        ('before-telegram', '2026-11-23', 'worker-1', 'عامل تجريبي', 2500, 'ملاحظة محفوظة', NOW, NOW))
        self.db.commit()
        worker = self.db.execute("SELECT phone FROM workers WHERE id='worker-1'").fetchone()
        withdrawal = self.db.execute("SELECT amount_milli,notes FROM withdrawals WHERE id='before-telegram'").fetchone()
        self.assertEqual(worker['phone'], '+962790000000')
        self.assertEqual((withdrawal['amount_milli'], withdrawal['notes']), (2500, 'ملاحظة محفوظة'))
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 3)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM telegram_notifications').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)

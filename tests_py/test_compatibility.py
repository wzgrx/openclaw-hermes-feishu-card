from __future__ import annotations

import json

from openclaw_hermes_feishu_card.compatibility import LegacyRuntimeReader


def test_legacy_runtime_reader_reads_tasks_and_balances(tmp_path) -> None:
    task_dir = tmp_path / "tasks"
    task_dir.mkdir()
    (task_dir / "sync.json").write_text(
        json.dumps(
            {
                "taskId": "sync",
                "name": "同步知识库",
                "status": "running",
                "progress": 42,
            }
        ),
        encoding="utf-8",
    )
    balance_path = tmp_path / "balance-cache.json"
    balance_path.write_text(
        json.dumps(
            {
                "results": [
                    {"platform": "DeepSeek", "total": 12.34, "available": True},
                    {"platform": "Unknown", "total": -1, "available": False},
                ]
            }
        ),
        encoding="utf-8",
    )

    snapshot = LegacyRuntimeReader(task_dir, balance_path, cache_seconds=0).sample()

    assert [(task.id, task.progress) for task in snapshot.tasks] == [("sync", 42)]
    assert [(balance.platform, balance.total) for balance in snapshot.balances] == [("DeepSeek", 12.34)]

# 测试

## TypeScript

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm pack --pack-destination artifacts
```

覆盖状态归并、定价、账本、凭据解析、卡片结构和元素上限。

## Python

```bash
pip install -e '.[hermes,dev]'
ruff check .
ruff format --check .
mypy hermes_feishu_card_footer
pytest
python -m build --outdir build/python
```

覆盖配置兼容、工具标记、Hermes 按轮使用量、工具边界与整轮终结判定、
CardKit 结构和跨日账本。

## WSL 冒烟测试

```bash
bash scripts/install-wsl.sh --all
openclaw plugins doctor
hermes plugins list
HERMES_BIN="$(readlink -f "$(command -v hermes)")"
"$(dirname "$HERMES_BIN")/python" -m hermes_feishu_card_footer.cli doctor
```

发送三类测试：

1. 纯文本回答。
2. 至少一个工具调用的回答。
3. 图片或文件回答，确认由原生通道投递。

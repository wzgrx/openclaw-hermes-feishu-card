# 测试

## TypeScript

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm compat:openclaw
pnpm compat:openclaw:beta # 安装 openclaw@beta 后运行
pnpm pack --pack-destination artifacts
```

覆盖状态归并、定价、账本、凭据解析、卡片结构和元素上限，并验证插件与
`@larksuite/openclaw-lark` 可被 OpenClaw 同时加载。

## Python

```bash
pip install -e '.[hermes,dev]'
ruff check .
ruff format --check .
mypy openclaw_hermes_feishu_card
pytest
python -m build --outdir build/python
```

覆盖配置兼容、工具标记、Hermes 按轮使用量、工具边界与整轮终结判定、
CardKit 结构、跨日账本、平台注册和发送/编辑/关闭流式状态的真实契约。

## WSL 冒烟测试

```bash
bash scripts/install-wsl.sh --all
openclaw plugins doctor
hermes plugins list
HERMES_BIN="$(readlink -f "$(command -v hermes)")"
"$(dirname "$HERMES_BIN")/python" -m openclaw_hermes_feishu_card.cli doctor
```

发送三类测试：

1. 纯文本回答。
2. 至少一个工具调用的回答。
3. 图片或文件回答，确认由原生通道投递。

# repository-layout Specification

## Purpose

让贡献者从仓库结构直接判断代码、脚本、测试和发布的归属，避免管理器与运行包构建再次形成隐含源码依赖。根目录集中项目级说明和 OpenSpec，两个业务项目能够分别构建，并通过实际产物验证组合行为。

## Requirements

### Requirement: 根目录明确区分两个业务项目

仓库 SHALL 以 `dsh-manager/` 和 `dsh-bun-build/` 为两个业务目录，项目级说明置于根 `desc/`，规划置于根 `openspec/`；README、LICENSE 和 `.github/` 等仓库基础设施保留根位置。业务脚本 MUST 属于对应项目，不保留根级通用 `scripts/` 或根级安装脚本。既有 `docs/` 内容 SHALL 归入 `desc/` 并修正入口链接，而非保留重复的文档树。

#### Scenario: RL-OWNERSHIP 从根目录定位职责
- **WHEN** 贡献者查找管理器构建、运行包构建和用户说明
- **THEN** 分别进入两个业务目录及根 desc，不需猜测一个通用根 scripts 下的脚本属于哪条产品线

### Requirement: 产品构建与源码依赖独立

管理器生产代码 SHALL 使用 Zig，并能够不构建 dsh、不调用 Bun 构建链而产出管理器。运行包项目 SHALL 能够不编译管理器而构建运行包。两者 MUST NOT 导入对方的业务实现来完成产品构建；跨项目配合通过版本化制品、元数据和启动协议验证，不额外引入承载耦合业务逻辑的根级 common 项目。

#### Scenario: RL-MANAGER-BUILD 仅构建管理器
- **WHEN** 贡献者在具备 Zig 工具链、没有上游 dsh 源码和 Bun 构建产物的环境构建管理器
- **THEN** 可以得到独立管理器，构建不要求生成运行包

#### Scenario: RL-RUNTIME-BUILD 仅构建运行包
- **WHEN** 贡献者使用运行包项目的构建入口生成目标产物
- **THEN** 构建不会调用 manager 的编译入口，产物不含 manager

### Requirement: 测试按行为归属并提供组合验收

管理器命令、存储、自举、补全、安装与自更新测试 SHALL 属于 `dsh-manager/`；上游转换、运行适配、Bun 构建和运行包检查 SHALL 属于 `dsh-bun-build/`。组合 E2E SHALL 显式接受两边制品，不能把导入另一个项目内部函数当作证明组合行为。CI SHALL 分别提供两边可执行的验证入口，并在受影响制品发布前运行相关组合门禁。

#### Scenario: RL-ARTIFACT-E2E 使用另一版本制品验证
- **WHEN** 候选管理器与已验收运行包，或候选运行包与已验收管理器，进入组合测试
- **THEN** 测试通过公开进程入口检验行为，不需要重编另一边来掩盖发布兼容问题

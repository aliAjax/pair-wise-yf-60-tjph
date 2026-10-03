# 无障碍人工审计协作工作台

源提示词摘要：审计员记录问题、复现步骤、影响人群和严重程度，审核员判断重复或补充证据，开发人员提交修复，复测人员关闭或重新打开问题；所有核心流程可以用键盘完成，并正确管理焦点和错误提示。

## 技术栈

SolidStart、TypeScript、Park UI、Solid Router、TanStack Query、Solid Store、Modular Forms、Zod、Solid i18n primitives。

## 本地运行

```bash
npm install
npm run dev
```

开发端口：`62025`

## 可用流程

- 创建审计问题，保存复现步骤、影响人群、证据和严重程度。
- 问题按待分诊、修复中、待复测、已关闭和重新打开流转。
- 将重复问题合并到主问题，保留来源关系和操作审计。
- 开发修复与复测结果分开记录，复测失败自动重新打开。
- 支持跳过导航、可见焦点、读屏提示、`N` 快捷键聚焦新建问题、`Ctrl+Enter` 提交。
- 数据保存在 localStorage，Park UI preset 与 Ark UI 可访问交互原语参与界面实现。

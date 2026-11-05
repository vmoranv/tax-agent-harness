import {
  ChartNoAxesColumn,
  Cpu,
  Database,
  FileText,
  History,
  MessageSquare,
  Radio,
  Terminal,
} from '@lucide/vue';
import { type Component, markRaw } from 'vue';

export interface menu {
  header?: string;
  value?: string;
  title?: string;
  icon?: string | Component;
  to?: string;
  divider?: boolean;
  chip?: string;
  chipColor?: string;
  chipVariant?: string;
  children?: menu[];
  disabled?: boolean;
  type?: string;
  subCaption?: string;
  isRawTitle?: boolean;
}

/** 导航项。计数徽标由 session store 填充（rules / traces）。 */
const sidebarItem: menu[] = [
  {
    title: '对话',
    icon: markRaw(MessageSquare),
    to: '/',
  },
  {
    title: '模型服务商',
    icon: markRaw(Cpu),
    to: '/providers',
  },
  {
    title: '消息渠道',
    icon: markRaw(Radio),
    to: '/platforms',
  },
  {
    title: '规则库',
    icon: markRaw(FileText),
    to: '/rules',
  },
  {
    title: '运行记录',
    icon: markRaw(History),
    to: '/traces',
  },
  {
    title: '日志控制台',
    icon: markRaw(Terminal),
    to: '/console',
  },
  {
    title: '评测中台',
    icon: markRaw(ChartNoAxesColumn),
    to: '/eval',
  },
  {
    title: '数据中台',
    icon: markRaw(Database),
    to: '/data',
  },
];

export default sidebarItem;

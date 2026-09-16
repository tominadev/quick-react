// 样式只作为副作用导入，由 esbuild 单独产出 bundle-*.css，TS 不需要知道它的内容。
declare module '*.css';

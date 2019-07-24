import { readdirSync } from "fs";
import path from "path";
import babel from "rollup-plugin-babel";
import commonjs from "rollup-plugin-commonjs";
import postcss from "rollup-plugin-postcss";
import external from "rollup-plugin-peer-deps-external";
import replace from "rollup-plugin-replace";
import resolve from "rollup-plugin-node-resolve";
import { terser } from "rollup-plugin-terser";
import del from "rollup-plugin-delete";

const env = process.env.NODE_ENV;

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".json"];

const getChunks = URI =>
  readdirSync(path.resolve(URI))
    .filter(x => x.includes(".js"))
    .reduce((a, c) => ({ ...a, [c.replace(".js", "")]: `src/${c}` }), {});

const commonPlugins = () => [
  external({
    includeDependencies: false
  }),
  postcss(),
  babel({
    babelrc: false,
    presets: [["@babel/preset-env", { modules: false }], "@babel/preset-react"],
    plugins: ["@babel/plugin-proposal-class-properties"],
    extensions: EXTENSIONS,
    exclude: "node_modules/**"
  }),
  commonjs({
    include: "node_modules/**"
  }),
  replace({ "process.env.NODE_ENV": JSON.stringify(env) }),
  resolve({
    extensions: EXTENSIONS,
    preferBuiltins: false
  })
];

export default [
  {
    input: "src/index.js",
    output: {
      esModule: false,
      file: "build/index.js",
      format: "umd",
      name: "authenticatedApp",
      exports: "named",
      globals: {
        react: "React",
        "react-dom": "ReactDOM",
        antd: "antd",
        uuid: "uuid"
      },
    },
    external: ['crypto', 'uuid'],
    plugins: [
      del({ targets: "build/*" }),
      ...commonPlugins(),
      env === "production" && terser()
    ]
  }
];

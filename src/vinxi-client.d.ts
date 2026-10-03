// vinxi 的 exports 把 ./client 的类型指向了未随包发布的 dist 路径，
// 这里直接引用包内实际提供的类型文件，保持与 "types": ["vinxi/client"] 相同的效果。
/// <reference path="../node_modules/vinxi/types/client.d.ts" />

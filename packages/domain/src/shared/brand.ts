/**
 * 品牌类型工具。
 *
 * 品牌只存在于类型层，运行时零开销：两个结构相同、
 * 语义不同的字符串（UserId 与 EnterpriseId）不能互相赋值。
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

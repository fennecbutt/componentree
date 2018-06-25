declare module NodeJS {
    interface Global {
        register(injectable: any): void;
    }
}

declare module NodeJS {
    interface Global {
        register(injectable: any): void; // NOTE move these into a property under global, so they're nicely organised
        earlyComponents: any[];
    }
}
//! Unit and scenario tests. They live inside the crate so that the mutation
//! switch (`crate::mutation`) is compiled for them and for nothing else.

mod chain_tests;
mod lab;
mod machine_tests;
mod mutation_tests;
mod sim_tests;

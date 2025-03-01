mod validate_empty_values;
mod validate_gas_used;
mod validate_propagated_sorted_values;
mod validate_propagated_values;

use crate::components::{
    tail_output_composer::meter_gas_used::meter_gas_used,
    tail_output_validator::{
        tail_output_hints::{generate_tail_output_hints, TailOutputHints},
        TailOutputValidator,
    },
};
use dep::types::{
    abis::{gas_settings::GasSettings, kernel_circuit_public_inputs::KernelCircuitPublicInputs},
    tests::fixture_builder::FixtureBuilder,
};

pub struct TailOutputValidatorBuilder {
    output: FixtureBuilder,
    previous_kernel: FixtureBuilder,
}

impl TailOutputValidatorBuilder {
    pub fn new() -> Self {
        let mut output = FixtureBuilder::new();
        let mut previous_kernel = FixtureBuilder::new();
        output.tx_context.gas_settings = GasSettings::default();
        previous_kernel.tx_context.gas_settings = GasSettings::default();
        output.set_first_nullifier();
        previous_kernel.set_first_nullifier();
        TailOutputValidatorBuilder { output, previous_kernel }
    }

    pub fn get_hints(self) -> TailOutputHints {
        let previous_kernel = self.previous_kernel.to_private_kernel_circuit_public_inputs();
        unsafe {
            generate_tail_output_hints(previous_kernel)
        }
    }

    pub fn export_output(self) -> KernelCircuitPublicInputs {
        let mut output = self.output.to_kernel_circuit_public_inputs();
        output.end.gas_used = meter_gas_used(output.end, output.constants.tx_context.gas_settings);
        output
    }

    pub fn validate(self) {
        let output = self.export_output();
        self.validate_with_output(output);
    }

    pub fn validate_with_output(self, output: KernelCircuitPublicInputs) {
        let previous_kernel = self.previous_kernel.to_private_kernel_circuit_public_inputs();
        TailOutputValidator::new(output, previous_kernel).validate();
    }

    pub fn validate_with_hints(self, hints: TailOutputHints) {
        let output = self.export_output();
        let previous_kernel = self.previous_kernel.to_private_kernel_circuit_public_inputs();
        TailOutputValidator { output, previous_kernel, hints }.validate();
    }
}
